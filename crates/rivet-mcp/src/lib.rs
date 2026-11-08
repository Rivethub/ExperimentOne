//! Minimal HTTP MCP-shaped tools for agents.
//!
//! Full MCP stdio transport can be layered later; this endpoint is enough for
//! local harness wiring. Keyword search always works; semantic search uses
//! stored lexical (or future remote) embeddings when vector_search is on.

use std::sync::Arc;

use anyhow::Result;
use axum::{
    extract::State,
    routing::{get, post},
    Json, Router,
};
use rivet_core::{cosine, lexical_embed, TrafficEvent};
use rivet_store::{MetaStore, TrafficStore};
use serde::{Deserialize, Serialize};
use tower_http::cors::CorsLayer;

#[derive(Clone)]
pub struct McpState {
    pub store: Arc<dyn TrafficStore>,
    pub meta: Arc<MetaStore>,
    pub vector_search: bool,
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
    pub results: Vec<TrafficEvent>,
}

#[derive(Serialize)]
pub struct ToolDescriptor {
    pub name: &'static str,
    pub description: &'static str,
}

pub fn router(state: McpState) -> Router {
    let mut r = Router::new()
        .route("/mcp", get(manifest))
        .route("/mcp/tools", get(tools))
        .route("/mcp/tools/search_history", post(search_history));
    if state.vector_search {
        r = r.route("/mcp/tools/semantic_search", post(semantic_search));
    }
    r.layer(CorsLayer::permissive()).with_state(state)
}

async fn manifest() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "name": "rivet",
        "version": "0.1.0",
        "description": "Query Rivet-captured AI traffic history"
    }))
}

async fn tools(State(state): State<McpState>) -> Json<Vec<ToolDescriptor>> {
    let mut tools = vec![ToolDescriptor {
        name: "search_history",
        description: "Keyword search over captured prompts and completions",
    }];
    if state.vector_search {
        tools.push(ToolDescriptor {
            name: "semantic_search",
            description: "Vector / lexical semantic search over history",
        });
    }
    Json(tools)
}

async fn search_history(
    State(state): State<McpState>,
    Json(req): Json<SearchRequest>,
) -> Result<Json<SearchResponse>, axum::http::StatusCode> {
    let results = state
        .store
        .search_keyword(&req.query, req.limit)
        .await
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(SearchResponse {
        mode: "keyword",
        results,
    }))
}

async fn semantic_search(
    State(state): State<McpState>,
    Json(req): Json<SearchRequest>,
) -> Result<Json<SearchResponse>, axum::http::StatusCode> {
    if !state.vector_search {
        return Err(axum::http::StatusCode::NOT_FOUND);
    }
    let query_vec = lexical_embed(&req.query);
    let embeddings = state
        .meta
        .all_embeddings()
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;

    let mut scored: Vec<(f32, String)> = embeddings
        .into_iter()
        .map(|(id, dims)| (cosine(&query_vec, &dims), id))
        .filter(|(score, _)| *score > 0.05)
        .collect();
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(req.limit as usize);

    // Fall back to keyword if nothing embedded yet.
    if scored.is_empty() {
        let results = state
            .store
            .search_keyword(&req.query, req.limit)
            .await
            .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
        return Ok(Json(SearchResponse {
            mode: "keyword_fallback",
            results,
        }));
    }

    let recent = state
        .store
        .recent(500)
        .await
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut by_id = std::collections::HashMap::new();
    for event in recent {
        by_id.insert(event.id.to_string(), event);
    }
    let mut results = Vec::new();
    for (_score, id) in scored {
        if let Some(event) = by_id.remove(&id) {
            results.push(event);
        }
    }
    Ok(Json(SearchResponse {
        mode: "semantic",
        results,
    }))
}

pub async fn serve(addr: std::net::SocketAddr, state: McpState) -> Result<()> {
    let app = router(state);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, "rivet mcp listening");
    axum::serve(listener, app).await?;
    Ok(())
}
