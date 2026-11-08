//! Local MCP tools for agents.
//!
//! Streamable HTTP MCP via the official `rmcp` SDK (`GET`/`POST /mcp` with SSE),
//! plus legacy REST tool routes for debugging. Keyword search always works;
//! semantic search is gated by `capabilities.vector_search`.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use axum::{
    extract::State,
    http::{header, Request, StatusCode},
    middleware::{self, Next},
    response::Response,
    routing::{get, post},
    Json, Router,
};
use rivet_core::{lexical_embed, RivetConfig, LEXICAL_SPACE};
use rivet_store::{ClickHouseTrafficStore, TrafficStore};
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
    pub store: Arc<dyn TrafficStore>,
    pub ch: Arc<ClickHouseTrafficStore>,
    pub config: Arc<RwLock<RivetConfig>>,
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

const fn default_limit() -> u32 {
    20
}

#[derive(Debug, Deserialize)]
pub struct SearchRequest {
    pub query: String,
    #[serde(default = "default_limit")]
    pub limit: u32,
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
}

#[allow(clippy::unused_async_trait_impl)] // `#[tool_handler]` generates async stubs.
#[tool_handler]
impl ServerHandler for RivetMcp {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("rivet", env!("CARGO_PKG_VERSION")))
            .with_protocol_version(ProtocolVersion::V_2025_03_26)
            .with_instructions(
                "Query Rivet-captured AI traffic. Tools: search_history, semantic_search.",
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

    let mcp_state = state.clone();
    let service = StreamableHttpService::new(
        move || Ok(RivetMcp::new(mcp_state.clone())),
        Arc::new(LocalSessionManager::default()),
        // Host/origin checks are enforced by `require_mcp_loopback` below.
        StreamableHttpServerConfig::default()
            .with_sse_keep_alive(Some(Duration::from_secs(15)))
            .with_legacy_session_mode(true)
            .disable_allowed_hosts(),
    );

    let legacy = Router::new()
        .route("/mcp/info", get(manifest))
        .route("/mcp/tools", get(tools))
        .route("/mcp/tools/search_history", post(search_history))
        .route("/mcp/tools/semantic_search", post(semantic_search))
        .with_state(state);

    // `route_service` (not nest) so `/mcp/info` and `/mcp/tools/*` stay available.
    Router::new()
        .route_service("/mcp", service)
        .merge(legacy)
        .route_layer(middleware::from_fn(require_mcp_loopback))
        .layer(cors)
}

async fn manifest() -> Json<serde_json::Value> {
    Json(json!({
        "name": "rivet",
        "version": env!("CARGO_PKG_VERSION"),
        "description": "Query Rivet-captured AI traffic history",
        "transport": "streamable-http",
        "protocol": "mcp",
        "sdk": "rmcp",
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

pub async fn serve(addr: SocketAddr, state: McpState) -> Result<()> {
    let app = router(state);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, "rivet mcp listening (rmcp streamable-http)");
    axum::serve(listener, app).await?;
    Ok(())
}
