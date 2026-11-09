//! Local MCP tools for agents.
//!
//! Single v1 surface: streamable HTTP MCP via the official `rmcp` SDK
//! (`GET`/`POST /mcp` with SSE). Keyword search always works; semantic search is
//! gated by `capabilities.vector_search`.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use axum::{
    extract::Request,
    http::{header, StatusCode},
    middleware::{self, Next},
    response::Response,
    Router,
};
use rivet_core::{
    hydrate_event_content, hydrate_events, lexical_embed, normalize_event_turns, RivetConfig,
    RivetPaths, LEXICAL_SPACE,
};
use rivet_store::{CaptureStore, ClickHouseCaptureStore, MetaStore};
use rmcp::transport::streamable_http_server::{
    session::local::LocalSessionManager,
    tower::{StreamableHttpServerConfig, StreamableHttpService},
};
use rmcp::{
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{
        CallToolResult, ContentBlock, Implementation, ProtocolVersion, ServerCapabilities,
        ServerConfig,
    },
    schemars, tool, tool_handler, tool_router, ErrorData as McpError, ServerHandler,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::RwLock;
use tower_http::cors::{AllowOrigin, CorsLayer};

#[derive(Clone)]
pub struct McpState {
    pub store: Arc<dyn CaptureStore>,
    pub ch: Arc<ClickHouseCaptureStore>,
    pub config: Arc<RwLock<RivetConfig>>,
    pub meta: Arc<MetaStore>,
    pub paths: RivetPaths,
}

impl std::fmt::Debug for McpState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpState").finish_non_exhaustive()
    }
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
pub struct SearchArgs {
    /// Search query over captured prompts and completions.
    pub query: String,
    /// Max results (1–100).
    #[serde(default = "default_limit")]
    pub limit: u32,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
pub struct IdArgs {
    /// Topic slug/id, event UUID, `event:<uuid>`, or session id.
    pub id: String,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
pub struct SessionBrowseArgs {
    /// Session id to browse.
    pub id: String,
    /// Max events (1–2000).
    #[serde(default = "default_browse_limit")]
    pub limit: u32,
}

const fn default_limit() -> u32 {
    20
}

const fn default_browse_limit() -> u32 {
    200
}

#[derive(Debug, Serialize)]
pub struct SearchResponse {
    pub mode: &'static str,
    pub results: Vec<rivet_core::CaptureEvent>,
}

#[derive(Clone)]
struct RivetMcp {
    state: McpState,
    /// Wired by `#[tool_handler]` for tools/list + tools/call dispatch.
    #[allow(dead_code)]
    tool_router: ToolRouter<Self>,
}

#[tool_router]
impl RivetMcp {
    fn new(state: McpState) -> Self {
        Self { state, tool_router: Self::tool_router() }
    }

    #[tool(description = "Keyword search over captured prompts and completions")]
    async fn search_history(
        &self,
        Parameters(args): Parameters<SearchArgs>,
    ) -> Result<CallToolResult, McpError> {
        let limit = args.limit.clamp(1, 100);
        if args.query.trim().is_empty() {
            return Err(McpError::invalid_params("query is required", None));
        }
        match do_search_history(&self.state, &args.query, limit).await {
            Ok(body) => Ok(CallToolResult::success(vec![
                ContentBlock::json(body).unwrap_or_else(|_| ContentBlock::text("{}"))
            ])),
            Err(()) => Err(McpError::internal_error("search failed", None)),
        }
    }

    #[tool(description = "Vector / lexical semantic search over history")]
    async fn semantic_search(
        &self,
        Parameters(args): Parameters<SearchArgs>,
    ) -> Result<CallToolResult, McpError> {
        let limit = args.limit.clamp(1, 100);
        if args.query.trim().is_empty() {
            return Err(McpError::invalid_params("query is required", None));
        }
        match do_semantic_search(&self.state, &args.query, limit).await {
            Ok(body) => Ok(CallToolResult::success(vec![
                ContentBlock::json(body).unwrap_or_else(|_| ContentBlock::text("{}"))
            ])),
            Err(err) => Err(McpError::internal_error(err, None)),
        }
    }

    #[tool(description = "Search durable knowledge topics")]
    async fn topic_search(
        &self,
        Parameters(args): Parameters<SearchArgs>,
    ) -> Result<CallToolResult, McpError> {
        let limit = args.limit.clamp(1, 100);
        match do_topic_search(&self.state, &args.query, limit) {
            Ok(body) => Ok(json_tool_result(body)),
            Err(()) => Err(McpError::internal_error("topic search failed", None)),
        }
    }

    #[tool(description = "Fetch one topic by slug or id")]
    async fn topic_get(
        &self,
        Parameters(args): Parameters<IdArgs>,
    ) -> Result<CallToolResult, McpError> {
        if args.id.trim().is_empty() {
            return Err(McpError::invalid_params("id is required", None));
        }
        match do_topic_get(&self.state, &args.id) {
            Ok(body) => Ok(json_tool_result(body)),
            Err(()) => Err(McpError::internal_error("topic get failed", None)),
        }
    }

    #[tool(description = "Hydrate a capture event or conversation with full bodies")]
    async fn get_full(
        &self,
        Parameters(args): Parameters<IdArgs>,
    ) -> Result<CallToolResult, McpError> {
        if args.id.trim().is_empty() {
            return Err(McpError::invalid_params("id is required", None));
        }
        match do_get_full(&self.state, &args.id).await {
            Ok(body) => Ok(json_tool_result(body)),
            Err(McpErrorKind::BadRequest) => Err(McpError::invalid_params("id is required", None)),
            Err(McpErrorKind::Internal) => Err(McpError::internal_error("get_full failed", None)),
        }
    }

    #[tool(description = "Browse normalized turns for a session")]
    async fn browse_session(
        &self,
        Parameters(args): Parameters<SessionBrowseArgs>,
    ) -> Result<CallToolResult, McpError> {
        if args.id.trim().is_empty() {
            return Err(McpError::invalid_params("id is required", None));
        }
        match do_browse_session(&self.state, &args.id, args.limit.clamp(1, 2000)).await {
            Ok(body) => Ok(json_tool_result(body)),
            Err(()) => Err(McpError::internal_error("browse_session failed", None)),
        }
    }

    #[tool(description = "Summary stats for memory / topics / wiki")]
    async fn memory_stats(&self) -> Result<CallToolResult, McpError> {
        match do_memory_stats(&self.state).await {
            Ok(body) => Ok(json_tool_result(body)),
            Err(()) => Err(McpError::internal_error("memory_stats failed", None)),
        }
    }
}

fn json_tool_result(body: serde_json::Value) -> CallToolResult {
    CallToolResult::success(vec![
        ContentBlock::json(body).unwrap_or_else(|_| ContentBlock::text("{}"))
    ])
}

#[allow(clippy::unused_async_trait_impl)] // `#[tool_handler]` generates async stubs.
#[tool_handler]
impl ServerHandler for RivetMcp {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("rivet", env!("CARGO_PKG_VERSION")))
            .with_protocol_version(ProtocolVersion::V_2025_03_26)
            .with_instructions(
                "Query Rivet-captured AI captures. Tools: search_history, semantic_search, \
                 topic_search, topic_get, get_full, browse_session, memory_stats. \
                 Hybrid conversation search and memory startup inject are control API routes \
                 (/v1/conversations/search?mode=hybrid, /v1/memory/startup).",
            )
    }
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

    let service = StreamableHttpService::new(
        move || Ok(RivetMcp::new(state.clone())),
        Arc::new(LocalSessionManager::default()),
        // Host/origin checks are enforced by `require_mcp_loopback` below.
        StreamableHttpServerConfig::default()
            .with_sse_keep_alive(Some(Duration::from_secs(15)))
            .disable_allowed_hosts(),
    );

    Router::new()
        .route_service("/mcp", service)
        .route_layer(middleware::from_fn(require_mcp_loopback))
        .layer(cors)
}

async fn do_search_history(
    state: &McpState,
    query: &str,
    limit: u32,
) -> Result<SearchResponse, ()> {
    let results = state.store.search_keyword(query, limit).await.map_err(|_| ())?;
    Ok(SearchResponse { mode: "keyword", results })
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

    // cosineDistance on unit vectors: similarity ≈ 1 - distance.
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

fn do_topic_search(state: &McpState, query: &str, limit: u32) -> Result<serde_json::Value, ()> {
    let topics =
        state.meta.search_topics(query, usize::try_from(limit).unwrap_or(20)).map_err(|_| ())?;
    Ok(json!({ "results": topics }))
}

fn do_topic_get(state: &McpState, id: &str) -> Result<serde_json::Value, ()> {
    let topic = state.meta.get_topic(id).map_err(|_| ())?;
    Ok(json!({ "topic": topic }))
}

enum McpErrorKind {
    BadRequest,
    Internal,
}

async fn do_get_full(state: &McpState, id: &str) -> Result<serde_json::Value, McpErrorKind> {
    let id = id.trim();
    if id.is_empty() {
        return Err(McpErrorKind::BadRequest);
    }
    let mut events = if let Some(eid) = id.strip_prefix("event:") {
        state.store.get_by_ids(&[eid.to_string()]).await.map_err(|_| McpErrorKind::Internal)?
    } else if id.len() == 36 {
        state.store.get_by_ids(&[id.to_string()]).await.map_err(|_| McpErrorKind::Internal)?
    } else {
        state.store.conversation_events(id, 500).await.map_err(|_| McpErrorKind::Internal)?
    };
    if events.len() == 1 {
        if let Some(event) = events.first_mut() {
            hydrate_event_content(&state.paths, event);
            let turns = normalize_event_turns(event);
            return Ok(json!({
                "event": event,
                "turns": turns,
                "hydrated": event.body_ref.is_some(),
            }));
        }
    }
    hydrate_events(&state.paths, &mut events);
    Ok(json!({ "events": events }))
}

async fn do_browse_session(
    state: &McpState,
    id: &str,
    limit: u32,
) -> Result<serde_json::Value, ()> {
    let mut events =
        state.store.conversation_events(id, limit.clamp(1, 2000)).await.map_err(|_| ())?;
    hydrate_events(&state.paths, &mut events);
    let turns: Vec<_> = events.iter().flat_map(normalize_event_turns).collect();
    Ok(json!({ "turns": turns, "events": events.len() }))
}

async fn do_memory_stats(state: &McpState) -> Result<serde_json::Value, ()> {
    let topics = state.meta.list_topics().map_or(0, |t| t.len());
    let project = state.config.read().await.wiki_project_id.clone();
    let wiki = state.meta.list_wiki_pages(&project).map_or(0, |p| p.len());
    let totals = state.store.usage_totals().await.unwrap_or_default();
    let embeddings = state.ch.embedding_count(LEXICAL_SPACE).await.unwrap_or(0);
    Ok(json!({
        "topics": topics,
        "wiki_pages": wiki,
        "capture_events": totals.events,
        "tokens_in": totals.tokens_in,
        "tokens_out": totals.tokens_out,
        "embeddings": embeddings,
    }))
}

pub async fn serve(addr: SocketAddr, state: McpState) -> Result<()> {
    let app = router(state);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, "rivet mcp listening (rmcp streamable-http)");
    axum::serve(listener, app).await?;
    Ok(())
}
