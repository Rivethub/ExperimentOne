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
use rivet_core::{cosine, lexical_embed, RivetConfig};
use rivet_store::{MetaStore, TrafficStore};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::RwLock;
use tower_http::cors::{AllowOrigin, CorsLayer};

#[derive(Clone)]
pub struct McpState {
    pub store: Arc<dyn TrafficStore>,
    pub meta: Arc<MetaStore>,
    pub config: Arc<RwLock<RivetConfig>>,
}

#[derive(Deserialize)]
pub struct SearchRequest {
    pub query: String,
    #[serde(default = "default_limit")]
    pub limit: u32,
}

fn default_limit() -> u32 {
    20
}

#[derive(Serialize)]
pub struct SearchResponse {
    pub mode: &'static str,
    pub results: Vec<rivet_core::TrafficEvent>,
}

#[derive(Serialize)]
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
        .map(rivet_core::host_is_loopback)
        .unwrap_or(false);
    if !host_ok {
        return Err(StatusCode::FORBIDDEN);
    }
    if let Some(origin) = req
        .headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
    {
        if !rivet_core::origin_allowed(origin) {
            return Err(StatusCode::FORBIDDEN);
        }
    }
    Ok(next.run(req).await)
}

pub fn router(state: McpState) -> Router {
    let cors = CorsLayer::new().allow_origin(AllowOrigin::predicate(|origin, _| {
        origin
            .to_str()
            .map(rivet_core::origin_allowed)
            .unwrap_or(false)
    }));
    Router::new()
        // Streamable HTTP: POST only on /mcp. GET returns 405 (not SSE yet).
        .route("/mcp", get(mcp_get_not_allowed).post(jsonrpc))
        .route("/mcp/info", get(manifest))
        .route("/mcp/tools", get(tools))
        .route("/mcp/tools/search_history", post(search_history))
        .route("/mcp/tools/semantic_search", post(semantic_search))
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
        "description": "Query Rivet-captured AI traffic history",
        "transport": "streamable-http",
        "protocol": "mcp",
        "jsonrpc": "2.0",
        "protocolVersion": "2025-03-26",
        "methods": ["initialize", "tools/list", "tools/call", "notifications/initialized", "ping"]
    }))
}

async fn tools(State(state): State<McpState>) -> Json<Vec<ToolDescriptor>> {
    Json(tool_descriptors(&state).await)
}

async fn tool_descriptors(state: &McpState) -> Vec<ToolDescriptor> {
    let mut tools = vec![ToolDescriptor {
        name: "search_history",
        description: "Keyword search over captured prompts and completions",
    }];
    if state.config.read().await.capabilities.vector_search {
        tools.push(ToolDescriptor {
            name: "semantic_search",
            description: "Vector / lexical semantic search over history",
        });
    }
    tools
}

fn tool_list_schema(tools: &[ToolDescriptor]) -> Value {
    let listed: Vec<Value> = tools
        .iter()
        .map(|t| {
            json!({
                "name": t.name,
                "description": t.description,
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "description": "Search query" },
                        "limit": { "type": "integer", "minimum": 1, "maximum": 100, "default": 20 }
                    },
                    "required": ["query"]
                }
            })
        })
        .collect();
    json!({ "tools": listed })
}

async fn jsonrpc(State(state): State<McpState>, Json(req): Json<JsonRpcRequest>) -> Response {
    let method = req.method.as_deref().unwrap_or("");
    let id = req.id.clone().unwrap_or(Value::Null);
    let is_notification = id.is_null() || method.starts_with("notifications/");

    // MCP notifications: 202 Accepted, empty body.
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
        }
        "tools/call" => {
            let name = req
                .params
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let args = req.params.get("arguments").cloned().unwrap_or(json!({}));
            let query = args
                .get("query")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let limit = args
                .get("limit")
                .and_then(|v| v.as_u64())
                .unwrap_or(20)
                .clamp(1, 100) as u32;
            if query.trim().is_empty() {
                Err(rpc_error(-32602, "query is required"))
            } else {
                match name {
                    "search_history" => match do_search_history(&state, &query, limit).await {
                        Ok(body) => Ok(json!({
                            "content": [{ "type": "text", "text": serde_json::to_string_pretty(&body).unwrap_or_default() }],
                            "isError": false
                        })),
                        Err(()) => Err(rpc_error(-32000, "search failed")),
                    },
                    "semantic_search" => match do_semantic_search(&state, &query, limit).await {
                        Ok(body) => Ok(json!({
                            "content": [{ "type": "text", "text": serde_json::to_string_pretty(&body).unwrap_or_default() }],
                            "isError": false
                        })),
                        Err(e) => Err(rpc_error(-32000, &e)),
                    },
                    _ => Err(rpc_error(-32601, &format!("unknown tool '{name}'"))),
                }
            }
        }
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

async fn do_search_history(
    state: &McpState,
    query: &str,
    limit: u32,
) -> Result<SearchResponse, ()> {
    let results = state
        .store
        .search_keyword(query, limit)
        .await
        .map_err(|_| ())?;
    Ok(SearchResponse {
        mode: "keyword",
        results,
    })
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
    let embeddings = state.meta.all_embeddings().map_err(|e| e.to_string())?;

    let mut scored: Vec<(f32, String)> = embeddings
        .into_iter()
        .filter(|(_, dims)| dims.len() == query_vec.len())
        .map(|(id, dims)| (cosine(&query_vec, &dims), id))
        .filter(|(score, _)| *score > 0.05)
        .collect();
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(limit as usize);

    if scored.is_empty() {
        let results = state
            .store
            .search_keyword(query, limit)
            .await
            .map_err(|e| e.to_string())?;
        return Ok(SearchResponse {
            mode: "keyword_fallback",
            results,
        });
    }

    let ids: Vec<String> = scored.iter().map(|(_, id)| id.clone()).collect();
    let found = state
        .store
        .get_by_ids(&ids)
        .await
        .map_err(|e| e.to_string())?;
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
    Ok(SearchResponse {
        mode: "semantic",
        results,
    })
}

async fn search_history(
    State(state): State<McpState>,
    Json(req): Json<SearchRequest>,
) -> Result<Json<SearchResponse>, StatusCode> {
    do_search_history(&state, &req.query, req.limit)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

async fn semantic_search(
    State(state): State<McpState>,
    Json(req): Json<SearchRequest>,
) -> Result<Json<SearchResponse>, StatusCode> {
    do_semantic_search(&state, &req.query, req.limit)
        .await
        .map(Json)
        .map_err(|err| {
            if err.contains("disabled") {
                StatusCode::NOT_FOUND
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            }
        })
}

pub async fn serve(addr: std::net::SocketAddr, state: McpState) -> Result<()> {
    let app = router(state);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, "rivet mcp listening");
    axum::serve(listener, app).await?;
    Ok(())
}
