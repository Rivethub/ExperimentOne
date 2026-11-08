//! Receives traffic events from the rivet-proxy sidecar.

use std::sync::Arc;

use anyhow::Result;
use axum::{
    extract::State,
    http::{header, Request, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use rivet_core::{validate_ingest_batch, validate_traffic_event, LiveBus, LiveEvent, TrafficEvent};
use rivet_store::{MetaStore, TrafficStore};
use serde::{Deserialize, Serialize};

#[derive(Clone)]
pub struct IngestState {
    pub store: Arc<dyn TrafficStore>,
    /// Shared with the proxy via `RIVET_INGEST_KEY` (usually `proxy_access_key`).
    pub ingest_key: String,
    /// Optional session→project map filled by harness plugins.
    pub meta: Option<Arc<MetaStore>>,
    /// Optional live bus so the control API can push traffic updates.
    pub live: Option<LiveBus>,
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

#[derive(Debug, Serialize)]
struct IngestErrorBody {
    error: String,
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

fn reject_validation(err: &rivet_core::IngestValidationError) -> Response {
    tracing::warn!(%err, "rejecting invalid ingest payload");
    (StatusCode::BAD_REQUEST, Json(IngestErrorBody { error: err.to_string() })).into_response()
}

async fn ingest_one(
    State(state): State<IngestState>,
    Json(mut event): Json<TrafficEvent>,
) -> Response {
    if let Err(err) = validate_traffic_event(&event) {
        return reject_validation(&err);
    }
    if let Some(meta) = state.meta.as_ref() {
        enrich_from_session_map(meta, &mut event);
    }
    if let Err(err) = state.store.insert_event(&event).await {
        tracing::error!(?err, "ingest failed");
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    if let Some(live) = state.live.as_ref() {
        live.publish(LiveEvent::Traffic { count: 1 });
    }
    StatusCode::ACCEPTED.into_response()
}

async fn ingest_batch(
    State(state): State<IngestState>,
    Json(batch): Json<IngestBatch>,
) -> Response {
    if let Err(err) = validate_ingest_batch(&batch.events) {
        return reject_validation(&err);
    }
    let mut events = batch.events;
    if let Some(meta) = state.meta.as_ref() {
        for event in &mut events {
            enrich_from_session_map(meta, event);
        }
    }
    let n = events.len() as u64;
    if let Err(err) = state.store.insert_batch(&events).await {
        tracing::error!(?err, "batch ingest failed");
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    if n > 0 {
        if let Some(live) = state.live.as_ref() {
            live.publish(LiveEvent::Traffic { count: n });
        }
    }
    StatusCode::ACCEPTED.into_response()
}

pub async fn serve(addr: std::net::SocketAddr, state: IngestState) -> Result<()> {
    let app = router(state);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, "rivet ingest listening");
    axum::serve(listener, app).await?;
    Ok(())
}
