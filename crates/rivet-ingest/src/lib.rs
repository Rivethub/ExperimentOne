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
use rivet_store::TrafficStore;
use serde::Deserialize;

#[derive(Clone)]
pub struct IngestState {
    pub store: Arc<dyn TrafficStore>,
    /// Shared with the proxy via `RIVET_INGEST_KEY` (usually proxy_access_key).
    pub ingest_key: String,
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
        .map(rivet_core::host_is_loopback)
        .unwrap_or(false);
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
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            require_ingest_auth,
        ))
        .with_state(state)
}

async fn ingest_one(
    State(state): State<IngestState>,
    Json(event): Json<TrafficEvent>,
) -> Result<StatusCode, StatusCode> {
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
    state
        .store
        .insert_batch(&batch.events)
        .await
        .map_err(|err| {
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
