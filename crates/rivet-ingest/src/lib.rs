//! Receives traffic events from the rivet-proxy sidecar.

use std::sync::Arc;

use anyhow::Result;
use axum::{
    extract::State,
    http::StatusCode,
    routing::post,
    Json, Router,
};
use rivet_core::TrafficEvent;
use rivet_store::TrafficStore;
use serde::Deserialize;

#[derive(Clone)]
pub struct IngestState {
    pub store: Arc<dyn TrafficStore>,
}

#[derive(Debug, Deserialize)]
pub struct IngestBatch {
    pub events: Vec<TrafficEvent>,
}

pub fn router(state: IngestState) -> Router {
    Router::new()
        .route("/v1/ingest", post(ingest_one))
        .route("/v1/ingest/batch", post(ingest_batch))
        .with_state(state)
}

async fn ingest_one(
    State(state): State<IngestState>,
    Json(event): Json<TrafficEvent>,
) -> Result<StatusCode, StatusCode> {
    state
        .store
        .insert_event(&event)
        .await
        .map_err(|err| {
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
