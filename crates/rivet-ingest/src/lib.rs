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
use rivet_core::{canonicalize_session_id, native_session_id, TrafficEvent};
use rivet_core::{normalize_event_turns, TurnKind};
use rivet_store::{
    MetaStore, NatsJobStore, TrafficStore, WorkerJob, PRIORITY_CLASSIFY, TASK_SYNTHESIZE_TOOL,
};
use serde::Deserialize;
use tracing::warn;

#[derive(Clone)]
pub struct IngestState {
    pub store: Arc<dyn TrafficStore>,
    /// Shared with the proxy via `RIVET_INGEST_KEY` (usually `proxy_access_key`).
    pub ingest_key: String,
    /// Optional session→project map filled by harness plugins.
    pub meta: Option<Arc<MetaStore>>,
    /// NATS `JetStream` job plane for live embed / classify enqueue after insert.
    pub jobs: Option<Arc<NatsJobStore>>,
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

fn canonicalize_event_session(event: &mut TrafficEvent) {
    if let Some(canonical) =
        canonicalize_session_id(event.provider, event.session_id.as_deref())
    {
        event.session_id = Some(canonical);
    }
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
    let native = native_session_id(session_id);
    let binding = meta
        .get_session_binding(session_id)
        .ok()
        .flatten()
        .or_else(|| meta.get_session_binding(native).ok().flatten());
    let Some(binding) = binding else {
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

fn prepare_ingest_event(meta: Option<&MetaStore>, event: &mut TrafficEvent) {
    canonicalize_event_session(event);
    if let Some(meta) = meta {
        enrich_from_session_map(meta, event);
        record_soft_wire_alias(meta, event);
    }
    upgrade_soft_session(meta, event);
    // soft_alias is ingest-only metadata — never persist to ClickHouse.
    event.soft_alias = None;
}

/// Persist soft→wire alias when the proxy reports a soft fingerprint alongside a hard id.
fn record_soft_wire_alias(meta: &MetaStore, event: &TrafficEvent) {
    let Some(soft) = event.soft_alias.as_deref().map(str::trim).filter(|s| s.starts_with("soft:"))
    else {
        return;
    };
    let Some(hard) = event.session_id.as_deref().map(str::trim).filter(|s| !s.is_empty() && !s.starts_with("soft:"))
    else {
        return;
    };
    let _ = meta.record_soft_wire(soft, hard);
}

/// Soft→wire upgrade: remap soft session ids via meta aliases; bump quality when hard.
fn upgrade_soft_session(meta: Option<&MetaStore>, event: &mut TrafficEvent) {
    if let Some(soft) = event.session_id.as_deref().map(str::trim).filter(|s| s.starts_with("soft:")) {
        if let Some(meta) = meta {
            if let Ok(Some(hard)) = meta.resolve_soft_wire(soft) {
                event.session_id = Some(hard);
                event.capture_quality = Some(rivet_core::CaptureQuality::Wire);
                return;
            }
        }
        return;
    }
    let Some(sid) = event.session_id.as_deref().map(str::trim) else {
        return;
    };
    if sid.starts_with("soft:") {
        return;
    }
    // Non-soft ids are already wire/canonical — mark capture quality up when soft was inferred.
    if event.capture_quality == Some(rivet_core::CaptureQuality::Soft) {
        event.capture_quality = Some(rivet_core::CaptureQuality::Wire);
    }
}

fn jobs_for_events(events: &[TrafficEvent]) -> Vec<WorkerJob> {
    let mut jobs = Vec::with_capacity(events.len().saturating_mul(2));
    let mut classified = std::collections::HashSet::new();
    for event in events {
        if !event.content.as_deref().unwrap_or("").trim().is_empty() {
            jobs.push(WorkerJob::embed_event(&event.id.to_string()));
        }
        if needs_tool_synth(event) {
            jobs.push(WorkerJob::new_pending(
                TASK_SYNTHESIZE_TOOL,
                &format!("synthesize-tool:{}", event.id),
                serde_json::json!({ "event_id": event.id.to_string() }).to_string(),
                PRIORITY_CLASSIFY,
            ));
        }
        let Some(session_id) =
            event.session_id.as_deref().map(str::trim).filter(|s| !s.is_empty())
        else {
            continue;
        };
        if session_id.starts_with("soft:") {
            continue;
        }
        // Classify when cwd is present but hard project evidence is missing.
        let needs_classify = event.project_id.as_deref().is_none_or(|p| p.trim().is_empty())
            && event.cwd.as_deref().is_some_and(|c| !c.trim().is_empty());
        if needs_classify && classified.insert(session_id.to_string()) {
            jobs.push(WorkerJob::classify_session(session_id));
        }
    }
    jobs
}

fn needs_tool_synth(event: &TrafficEvent) -> bool {
    normalize_event_turns(event).iter().any(|t| {
        t.tool_name.as_deref().is_some_and(|n| !n.is_empty())
            && (t.kind == TurnKind::Tool || t.tool_args.as_deref().is_some_and(|a| !a.is_empty()))
            && t.text.trim().is_empty()
    })
}

async fn enqueue_followups(jobs: Option<&NatsJobStore>, events: &[TrafficEvent]) {
    let Some(jobs_store) = jobs else {
        return;
    };
    let batch = jobs_for_events(events);
    if batch.is_empty() {
        return;
    }
    if let Err(err) = jobs_store.enqueue_jobs(&batch).await {
        warn!(?err, n = batch.len(), "ingest job enqueue failed");
    }
}

async fn ingest_one(
    State(state): State<IngestState>,
    Json(mut event): Json<TrafficEvent>,
) -> Result<StatusCode, StatusCode> {
    prepare_ingest_event(state.meta.as_deref(), &mut event);
    state.store.insert_event(&event).await.map_err(|err| {
        tracing::error!(?err, "ingest failed");
        StatusCode::INTERNAL_SERVER_ERROR
    })?;
    enqueue_followups(state.jobs.as_deref(), std::slice::from_ref(&event)).await;
    Ok(StatusCode::ACCEPTED)
}

async fn ingest_batch(
    State(state): State<IngestState>,
    Json(batch): Json<IngestBatch>,
) -> Result<StatusCode, StatusCode> {
    let mut events = batch.events;
    for event in &mut events {
        prepare_ingest_event(state.meta.as_deref(), event);
    }
    state.store.insert_batch(&events).await.map_err(|err| {
        tracing::error!(?err, "batch ingest failed");
        StatusCode::INTERNAL_SERVER_ERROR
    })?;
    enqueue_followups(state.jobs.as_deref(), &events).await;
    Ok(StatusCode::ACCEPTED)
}

pub async fn serve(addr: std::net::SocketAddr, state: IngestState) -> Result<()> {
    let app = router(state);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, "rivet ingest listening");
    axum::serve(listener, app).await?;
    Ok(())
}
