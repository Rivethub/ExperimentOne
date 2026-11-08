//! Receives traffic events from the rivet-proxy sidecar.

use std::sync::Arc;

use anyhow::Result;
use axum::{
    extract::State,
    http::{header, Request, StatusCode},
    middleware::{self, Next},
    response::Response,
    routing::post,
    Json, Router,
};
use rivet_core::TrafficEvent;
use rivet_store::{MetaStore, TrafficStore};
use serde::Deserialize;

#[derive(Clone)]
pub struct IngestState {
    pub store: Arc<dyn TrafficStore>,
    /// Shared with the proxy via `RIVET_INGEST_KEY` (usually `proxy_access_key`).
    pub ingest_key: String,
    /// Optional session→project map filled by harness plugins.
    pub meta: Option<Arc<MetaStore>>,
}

impl std::fmt::Debug for IngestState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IngestState").finish_non_exhaustive()
    }
}

#[derive(Debug, Deserialize)]
pub struct IngestBatch {
    pub events: Vec<TrafficEvent>,
}

async fn require_ingest_auth(
    State(state): State<IngestState>,
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
    let provided = req
        .headers()
        .get("x-rivet-ingest-key")
        .or_else(|| req.headers().get("x-rivet-key"))
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .trim();
    if provided.is_empty() || provided != state.ingest_key {
        return Err(StatusCode::UNAUTHORIZED);
    }
    Ok(next.run(req).await)
}

pub fn router(state: IngestState) -> Router {
    Router::new()
        .route("/v1/ingest", post(ingest_one))
        .route("/v1/ingest/batch", post(ingest_batch))
        .route_layer(middleware::from_fn_with_state(state.clone(), require_ingest_auth))
        .with_state(state)
}

fn enrich_from_session_map(meta: &MetaStore, event: &mut TrafficEvent) {
    let Some(session_id) = event.session_id.as_deref().map(str::trim).filter(|s| !s.is_empty())
    else {
        return;
    };
    // Soft hashes never match plugin SessionStart UUIDs.
    if session_id.starts_with("soft:") {
        return;
    }
    let Ok(Some(binding)) = meta.get_session_binding(session_id) else {
        return;
    };
    if event.project_id.as_deref().unwrap_or("").trim().is_empty() {
        if let Some(project_id) = binding.project_id.filter(|p| !p.trim().is_empty()) {
            event.project_id = Some(project_id);
        }
    }
    if event.cwd.as_deref().unwrap_or("").trim().is_empty() {
        if let Some(cwd) = binding.cwd.filter(|c| !c.trim().is_empty()) {
            event.cwd = Some(cwd);
        }
    }
}

async fn ingest_one(
    State(state): State<IngestState>,
    Json(mut event): Json<TrafficEvent>,
) -> Result<StatusCode, StatusCode> {
    if let Some(meta) = state.meta.as_ref() {
        enrich_from_session_map(meta, &mut event);
    }
    state.store.insert_event(&event).await.map_err(|err| {
        tracing::error!(?err, "ingest failed");
        StatusCode::INTERNAL_SERVER_ERROR
    })?;
    Ok(StatusCode::ACCEPTED)
}

async fn ingest_batch(
    State(state): State<IngestState>,
    Json(batch): Json<IngestBatch>,
) -> Result<StatusCode, StatusCode> {
    let mut events = batch.events;
    if let Some(meta) = state.meta.as_ref() {
        for event in &mut events {
            enrich_from_session_map(meta, event);
        }
    }
    state.store.insert_batch(&events).await.map_err(|err| {
        tracing::error!(?err, "batch ingest failed");
        StatusCode::INTERNAL_SERVER_ERROR
    })?;
    Ok(StatusCode::ACCEPTED)
}

pub async fn serve(addr: std::net::SocketAddr, state: IngestState) -> Result<()> {
    let app = router(state);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, "rivet ingest listening");
    axum::serve(listener, app).await?;
    Ok(())
}
