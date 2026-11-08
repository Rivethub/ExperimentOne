//! Local MCP tools for agents.
//!
//! Supports Streamable HTTP JSON-RPC on `POST /mcp` (initialize / tools/list /
//! tools/call / notifications/initialized) plus legacy REST tool routes for
//! debugging. Keyword search always works; semantic search is gated by
//! `capabilities.vector_search`.

use std::sync::Arc;

use anyhow::Result;
use axum::{
    extract::State,
    http::{header, Request, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use rivet_core::{
    assemble_startup_memory_with_workspace, hydrate_event_content, hydrate_events,
    lexical_embed, load_workspace_memory,
    normalize_event_turns, RivetConfig, RivetPaths, LEXICAL_SPACE,
};
use rivet_store::{
    fuse_event_id_arms, hybrid_fetch_limit, ClickHouseTrafficStore, MetaStore, TrafficStore,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::RwLock;
use tower_http::cors::{AllowOrigin, CorsLayer};

#[derive(Clone)]
pub struct McpState {
    pub store: Arc<dyn TrafficStore>,
    pub ch: Arc<ClickHouseTrafficStore>,
    pub config: Arc<RwLock<RivetConfig>>,
    pub meta: Arc<MetaStore>,
    pub paths: RivetPaths,
}

impl std::fmt::Debug for McpState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpState").finish_non_exhaustive()
    }
}

#[derive(Debug, Deserialize)]
pub struct SearchRequest {
    pub query: String,
    #[serde(default = "default_limit")]
    pub limit: u32,
}

const fn default_limit() -> u32 {
    20
}

#[derive(Debug, Serialize)]
pub struct SearchResponse {
    pub mode: &'static str,
    pub results: Vec<rivet_core::TrafficEvent>,
}

#[derive(Debug, Copy, Clone, Serialize)]
pub struct ToolDescriptor {
    pub name: &'static str,
    pub description: &'static str,
}

#[derive(Deserialize)]
struct JsonRpcRequest {
    #[serde(default)]
    #[allow(dead_code)]
    jsonrpc: Option<String>,
    id: Option<Value>,
    method: Option<String>,
    #[serde(default)]
    params: Value,
}

async fn require_mcp_loopback(
    req: Request<axum::body::Body>,
    next: Next,
) -> Result<Response, StatusCode> {
    let host_ok = req
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .is_some_and(rivet_core::host_is_loopback);
    if !host_ok {
        return Err(StatusCode::FORBIDDEN);
    }
    if let Some(origin) = req.headers().get(header::ORIGIN).and_then(|v| v.to_str().ok()) {
        if !rivet_core::origin_allowed(origin) {
            return Err(StatusCode::FORBIDDEN);
        }
    }
    Ok(next.run(req).await)
}

pub fn router(state: McpState) -> Router {
    let cors = CorsLayer::new().allow_origin(AllowOrigin::predicate(|origin, _| {
        origin.to_str().is_ok_and(rivet_core::origin_allowed)
    }));
    Router::new()
        .route("/mcp", get(mcp_get_not_allowed).post(jsonrpc))
        .route("/mcp/info", get(manifest))
        .route("/mcp/tools", get(tools))
        .route("/mcp/tools/search_history", post(search_history))
        .route("/mcp/tools/semantic_search", post(semantic_search))
        .route("/mcp/tools/topic_search", post(topic_search_rest))
        .route("/mcp/tools/topic_get", post(topic_get_rest))
        .route("/mcp/tools/get_full", post(get_full_rest))
        .route("/mcp/tools/browse_session", post(browse_session_rest))
        .route("/mcp/tools/memory_stats", post(memory_stats_rest))
        .route_layer(middleware::from_fn(require_mcp_loopback))
        .layer(cors)
        .with_state(state)
}

async fn mcp_get_not_allowed() -> StatusCode {
    StatusCode::METHOD_NOT_ALLOWED
}

async fn manifest() -> Json<Value> {
    Json(json!({
        "name": "rivet",
        "version": "0.1.0",
        "description": "Query Rivet-captured AI traffic history, topics, and memory",
        "transport": "streamable-http",
        "protocol": "mcp",
        "jsonrpc": "2.0",
        "methods": ["initialize", "tools/list", "tools/call", "notifications/initialized", "ping"]
    }))
}

async fn tools(State(state): State<McpState>) -> Json<Vec<ToolDescriptor>> {
    Json(tool_descriptors(&state).await)
}

async fn tool_descriptors(state: &McpState) -> Vec<ToolDescriptor> {
    let mut tools = vec![
        ToolDescriptor {
            name: "search_history",
            description: "Keyword search over captured prompts and completions",
        },
        ToolDescriptor {
            name: "topic_search",
            description: "Search durable topics derived from captured traffic",
        },
        ToolDescriptor {
            name: "topic_get",
            description: "Get one topic by slug, including event/session citations",
        },
        ToolDescriptor {
            name: "get_full",
            description: "Hydrate a traffic event (body_ref) and normalize turns",
        },
        ToolDescriptor {
            name: "browse_session",
            description: "Browse one conversation with turns, enrichments, and summary",
        },
        ToolDescriptor {
            name: "memory_stats",
            description: "Coverage stats for traffic, topics, summaries, and embeddings",
        },
        ToolDescriptor {
            name: "memory_startup",
            description: "Assemble budgeted startup memory (workspace SOUL/IDENTITY/MEMORY + topic recall)",
        },
    ];
    if state.config.read().await.capabilities.vector_search {
        tools.push(ToolDescriptor {
            name: "semantic_search",
            description: "Vector / lexical semantic search over history",
        });
        tools.push(ToolDescriptor {
            name: "hybrid_search",
            description: "RRF fusion of keyword + vector search (preferred recall)",
        });
    }
    tools
}

fn tool_input_schema(name: &str) -> Value {
    match name {
        "memory_stats" => json!({
            "type": "object",
            "properties": {},
            "additionalProperties": false
        }),
        "memory_startup" => json!({
            "type": "object",
            "properties": {
                "topic": { "type": "string", "description": "Topic slug" },
                "query": { "type": "string", "description": "Optional hybrid query" },
                "cwd": { "type": "string", "description": "Project root — loads SOUL.md / IDENTITY.md / MEMORY.md" },
                "limit": { "type": "integer", "minimum": 1, "maximum": 20, "default": 8 }
            },
            "required": []
        }),
        "topic_get" | "get_full" | "browse_session" => json!({
            "type": "object",
            "properties": {
                "id": { "type": "string", "description": "Topic slug, event id, or session id" },
                "query": { "type": "string", "description": "Alias for id" },
                "limit": { "type": "integer", "minimum": 1, "maximum": 500, "default": 50 }
            },
            "required": []
        }),
        _ => json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "Search query" },
                "limit": { "type": "integer", "minimum": 1, "maximum": 100, "default": 20 }
            },
            "required": ["query"]
        }),
    }
}

fn tool_list_schema(tools: &[ToolDescriptor]) -> Value {
    let listed: Vec<Value> = tools
        .iter()
        .map(|t| {
            json!({
                "name": t.name,
                "description": t.description,
                "inputSchema": tool_input_schema(t.name)
            })
        })
        .collect();
    json!({ "tools": listed })
}

fn arg_string(args: &Value, keys: &[&str]) -> String {
    for key in keys {
        if let Some(v) = args.get(*key).and_then(Value::as_str) {
            let t = v.trim();
            if !t.is_empty() {
                return t.to_string();
            }
        }
    }
    String::new()
}

async fn jsonrpc(State(state): State<McpState>, Json(req): Json<JsonRpcRequest>) -> Response {
    let method = req.method.as_deref().unwrap_or("");
    let id = req.id.clone().unwrap_or(Value::Null);
    let is_notification = id.is_null() || method.starts_with("notifications/");

    if is_notification {
        return StatusCode::ACCEPTED.into_response();
    }

    let result = match method {
        "initialize" => Ok(json!({
            "protocolVersion": "2025-03-26",
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "rivet", "version": "0.1.0" }
        })),
        "ping" => Ok(json!({})),
        "tools/list" => {
            let tools = tool_descriptors(&state).await;
            Ok(tool_list_schema(&tools))
        },
        "tools/call" => {
            let name = req.params.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let args = req.params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            match call_tool(&state, name, &args).await {
                Ok(body) => Ok(json!({
                    "content": [{ "type": "text", "text": serde_json::to_string_pretty(&body).unwrap_or_default() }],
                    "isError": false
                })),
                Err(err) => Err(rpc_error(err.0, &err.1)),
            }
        },
        "" => Err(rpc_error(-32600, "missing method")),
        other => Err(rpc_error(-32601, &format!("method not found: {other}"))),
    };

    match result {
        Ok(value) => Json(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": value
        }))
        .into_response(),
        Err(err) => Json(json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": err
        }))
        .into_response(),
    }
}

fn rpc_error(code: i64, message: &str) -> Value {
    json!({ "code": code, "message": message })
}

async fn call_tool(state: &McpState, name: &str, args: &Value) -> Result<Value, (i64, String)> {
    let query = arg_string(args, &["query", "id", "slug"]);
    let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(20).clamp(1, 500) as u32;
    match name {
        "search_history" => {
            if query.is_empty() {
                return Err((-32602, "query is required".into()));
            }
            do_search_history(state, &query, limit)
                .await
                .map(|body| serde_json::to_value(body).unwrap_or_default())
                .map_err(|()| (-32000, "search failed".into()))
        },
        "semantic_search" => {
            if query.is_empty() {
                return Err((-32602, "query is required".into()));
            }
            do_semantic_search(state, &query, limit)
                .await
                .map(|body| serde_json::to_value(body).unwrap_or_default())
                .map_err(|e| (-32000, e))
        },
        "hybrid_search" => {
            if query.is_empty() {
                return Err((-32602, "query is required".into()));
            }
            do_hybrid_search(state, &query, limit)
                .await
                .map(|body| serde_json::to_value(body).unwrap_or_default())
                .map_err(|e| (-32000, e))
        },
        "memory_startup" => {
            let topic = arg_string(args, &["topic", "slug"]);
            let cwd = arg_string(args, &["cwd", "path", "project"]);
            do_memory_startup(state, topic.as_str(), query.as_str(), cwd.as_str(), limit).await
        },
        "topic_search" => {
            let rows = state
                .meta
                .search_topics(&query, limit as usize)
                .map_err(|e| (-32000, e.to_string()))?;
            Ok(json!({ "topics": rows }))
        },
        "topic_get" => {
            if query.is_empty() {
                return Err((-32602, "id/slug is required".into()));
            }
            let topic = state
                .meta
                .get_topic(&query)
                .map_err(|e| (-32000, e.to_string()))?
                .ok_or_else(|| (-32000, "topic not found".into()))?;
            Ok(serde_json::to_value(topic).unwrap_or_default())
        },
        "get_full" => {
            if query.is_empty() {
                return Err((-32602, "id is required".into()));
            }
            do_get_full(state, &query).await
        },
        "browse_session" => {
            if query.is_empty() {
                return Err((-32602, "id is required".into()));
            }
            do_browse_session(state, &query, limit).await
        },
        "memory_stats" => do_memory_stats(state).await,
        _ => Err((-32601, format!("unknown tool '{name}'"))),
    }
}

async fn do_search_history(
    state: &McpState,
    query: &str,
    limit: u32,
) -> Result<SearchResponse, ()> {
    let results = state.store.search_keyword(query, limit).await.map_err(|_| ())?;
    Ok(SearchResponse { mode: "keyword", results })
}

async fn do_hybrid_search(
    state: &McpState,
    query: &str,
    limit: u32,
) -> Result<SearchResponse, String> {
    if !state.config.read().await.capabilities.vector_search {
        return Err("vector_search capability disabled".into());
    }
    let fetch = hybrid_fetch_limit(limit);
    let keyword = state.store.search_keyword(query, fetch).await.map_err(|e| e.to_string())?;
    let keyword_ids: Vec<String> = keyword.iter().map(|e| e.id.to_string()).collect();
    let query_vec = lexical_embed(query);
    let hits = state
        .ch
        .search_embeddings(LEXICAL_SPACE, &query_vec, fetch)
        .await
        .map_err(|e| e.to_string())?;
    let vector_ids: Vec<String> = hits
        .into_iter()
        .filter(|h| 1.0 - h.distance > 0.05)
        .map(|h| {
            h.event_id
                .split("#c")
                .next()
                .unwrap_or(h.event_id.as_str())
                .to_string()
        })
        .collect();
    if keyword_ids.is_empty() && vector_ids.is_empty() {
        return Ok(SearchResponse { mode: "keyword_fallback", results: keyword });
    }
    let summary_ids: Vec<String> = state
        .meta
        .list_summaries()
        .unwrap_or_default()
        .into_iter()
        .flat_map(|s| s.event_ids)
        .collect();
    let fused = fuse_event_id_arms(&keyword_ids, &vector_ids, &summary_ids, limit);
    let mut fetch_ids = fused.clone();
    if let Ok(extra) = state.meta.expand_events_via_lineage(&fused, 24) {
        for id in extra {
            if !fetch_ids.iter().any(|f| f == &id) {
                fetch_ids.push(id);
            }
        }
    }
    let found = state.store.get_by_ids(&fetch_ids).await.map_err(|e| e.to_string())?;
    let mut by_id = std::collections::HashMap::new();
    for event in found {
        by_id.insert(event.id.to_string(), event);
    }
    let mut results = Vec::new();
    // Keep RRF order first, then lineage extras.
    for id in fetch_ids {
        if let Some(event) = by_id.remove(&id) {
            results.push(event);
        }
    }
    if results.len() > limit as usize {
        results.truncate(limit.max(1) as usize);
    }
    Ok(SearchResponse { mode: "hybrid", results })
}

async fn do_memory_startup(
    state: &McpState,
    topic_slug: &str,
    query: &str,
    cwd: &str,
    limit: u32,
) -> Result<Value, (i64, String)> {
    let topic = if topic_slug.is_empty() {
        None
    } else {
        state.meta.get_topic(topic_slug).map_err(|e| (-32000, e.to_string()))?
    };
    let topic_title = topic.as_ref().map(|t| t.title.clone());
    let topic_page = topic.as_ref().and_then(|t| t.startup_context.clone().or_else(|| t.summary.clone()));
    let workspace = if cwd.trim().is_empty() {
        Vec::new()
    } else {
        load_workspace_memory(std::path::Path::new(cwd.trim()))
    };
    let recent = state.store.recent(40).await.map_err(|e| (-32000, e.to_string()))?;
    let recent_lines: Vec<String> = recent
        .iter()
        .take(12)
        .map(|e| {
            format!(
                "{} · {}",
                e.session_id.as_deref().unwrap_or("-"),
                e.content.as_deref().unwrap_or("").chars().take(100).collect::<String>()
            )
        })
        .collect();
    let mut hit_lines = Vec::new();
    if !query.is_empty() {
        if let Ok(body) = do_hybrid_search(state, query, limit.clamp(1, 20)).await {
            for e in body.results {
                hit_lines.push(
                    e.content.as_deref().unwrap_or("").chars().take(120).collect::<String>(),
                );
            }
        }
    }
    let markdown = assemble_startup_memory_with_workspace(
        topic_title.as_deref(),
        topic_page.as_deref(),
        &workspace,
        &recent_lines,
        &hit_lines,
    );
    Ok(json!({
        "markdown": markdown,
        "topic": topic,
        "workspace_sections": workspace.iter().map(|s| s.title.clone()).collect::<Vec<_>>(),
    }))
}

async fn do_semantic_search(
    state: &McpState,
    query: &str,
    limit: u32,
) -> Result<SearchResponse, String> {
    if !state.config.read().await.capabilities.vector_search {
        return Err("vector_search capability disabled".into());
    }

    let query_vec = lexical_embed(query);
    let hits = state
        .ch
        .search_embeddings(LEXICAL_SPACE, &query_vec, limit)
        .await
        .map_err(|e| e.to_string())?;

    let scored: Vec<(f32, String)> = hits
        .into_iter()
        .map(|h| (1.0 - h.distance, h.event_id))
        .filter(|(score, _)| *score > 0.05)
        .collect();

    if scored.is_empty() {
        let results = state.store.search_keyword(query, limit).await.map_err(|e| e.to_string())?;
        return Ok(SearchResponse { mode: "keyword_fallback", results });
    }

    let ids: Vec<String> = scored.iter().map(|(_, id)| id.clone()).collect();
    let found = state.store.get_by_ids(&ids).await.map_err(|e| e.to_string())?;
    let mut by_id = std::collections::HashMap::new();
    for event in found {
        by_id.insert(event.id.to_string(), event);
    }
    let mut results = Vec::new();
    for (_score, id) in scored {
        if let Some(event) = by_id.remove(&id) {
            results.push(event);
        }
    }
    Ok(SearchResponse { mode: "semantic", results })
}

async fn do_get_full(state: &McpState, id: &str) -> Result<Value, (i64, String)> {
    let mut events =
        state.store.get_by_ids(&[id.to_string()]).await.map_err(|e| (-32000, e.to_string()))?;
    let Some(mut event) = events.pop() else {
        return Err((-32000, "event not found".into()));
    };
    hydrate_event_content(&state.paths, &mut event);
    let turns = normalize_event_turns(&event);
    Ok(json!({
        "event": event,
        "turns": turns,
        "hydrated": event.body_ref.is_some(),
    }))
}

async fn do_browse_session(state: &McpState, id: &str, limit: u32) -> Result<Value, (i64, String)> {
    let mut events = state
        .store
        .conversation_events(id, limit)
        .await
        .map_err(|e| (-32000, e.to_string()))?;
    hydrate_events(&state.paths, &mut events);
    let enrichments = state.meta.list_enrichments(id, 200).unwrap_or_default();
    let summary = state.meta.get_summary_for_session(id).ok().flatten();
    let turns: Vec<_> = events.iter().flat_map(normalize_event_turns).collect();
    Ok(json!({
        "id": id,
        "events": events,
        "turns": turns,
        "enrichments": enrichments,
        "summary": summary,
    }))
}

async fn do_memory_stats(state: &McpState) -> Result<Value, (i64, String)> {
    let usage = state.store.usage_totals().await.map_err(|e| (-32000, e.to_string()))?;
    Ok(json!({
        "events": usage.events,
        "tokens_in": usage.tokens_in,
        "tokens_out": usage.tokens_out,
        "topics": state.meta.list_topics().map_or(0, |t| t.len()),
        "summaries": state.meta.list_summaries().map_or(0, |s| s.len()),
        "embeddings": state.ch.embedding_count(LEXICAL_SPACE).await.unwrap_or(0),
    }))
}

async fn search_history(
    State(state): State<McpState>,
    Json(req): Json<SearchRequest>,
) -> Result<Json<SearchResponse>, StatusCode> {
    do_search_history(&state, &req.query, req.limit)
        .await
        .map(Json)
        .map_err(|()| StatusCode::INTERNAL_SERVER_ERROR)
}

async fn semantic_search(
    State(state): State<McpState>,
    Json(req): Json<SearchRequest>,
) -> Result<Json<SearchResponse>, StatusCode> {
    do_semantic_search(&state, &req.query, req.limit).await.map(Json).map_err(|err| {
        if err.contains("disabled") {
            StatusCode::NOT_FOUND
        } else {
            StatusCode::INTERNAL_SERVER_ERROR
        }
    })
}

async fn topic_search_rest(
    State(state): State<McpState>,
    Json(req): Json<SearchRequest>,
) -> Result<Json<Value>, StatusCode> {
    call_tool(&state, "topic_search", &json!({ "query": req.query, "limit": req.limit }))
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

async fn topic_get_rest(
    State(state): State<McpState>,
    Json(req): Json<SearchRequest>,
) -> Result<Json<Value>, StatusCode> {
    call_tool(&state, "topic_get", &json!({ "id": req.query }))
        .await
        .map(Json)
        .map_err(|_| StatusCode::NOT_FOUND)
}

async fn get_full_rest(
    State(state): State<McpState>,
    Json(req): Json<SearchRequest>,
) -> Result<Json<Value>, StatusCode> {
    call_tool(&state, "get_full", &json!({ "id": req.query }))
        .await
        .map(Json)
        .map_err(|_| StatusCode::NOT_FOUND)
}

async fn browse_session_rest(
    State(state): State<McpState>,
    Json(req): Json<SearchRequest>,
) -> Result<Json<Value>, StatusCode> {
    call_tool(&state, "browse_session", &json!({ "id": req.query, "limit": req.limit }))
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

async fn memory_stats_rest(State(state): State<McpState>) -> Result<Json<Value>, StatusCode> {
    call_tool(&state, "memory_stats", &json!({})).await.map(Json).map_err(|_| {
        StatusCode::INTERNAL_SERVER_ERROR
    })
}

pub async fn serve(addr: std::net::SocketAddr, state: McpState) -> Result<()> {
    let app = router(state);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, "rivet mcp listening");
    axum::serve(listener, app).await?;
    Ok(())
}
