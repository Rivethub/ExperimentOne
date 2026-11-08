//! Control plane API used by the desktop host (local IPC) and loopback CLI.

mod live_routes;
mod openapi;
mod quota;

/// `OpenAPI` document for codegen / CI contract checks.
pub fn openapi_document() -> utoipa::openapi::OpenApi {
    use utoipa::OpenApi;
    openapi::ApiDoc::openapi()
}

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use anyhow::Result;
use axum::http::Request;
use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use chrono::{Duration, Utc};
use rivet_core::{
    age_days_since, assemble_startup_memory_with_workspace, claude_mcp_json, claude_settings_json,
    codex_config_toml, conversations_from_events, harness_user_ready, hydrate_event_content,
    lexical_embed, load_workspace_memory, localhost_port_free, normalize_event_turns,
    project_id_from_cwd, provider_catalog, recency_boost, resolve_project_root, Capabilities,
    ConversationSummary, LiveBus, ProviderKind, RivetConfig, RivetPaths, TrafficEvent, TrafficRole,
    UsageTotals, WorkspaceMemorySection, LEXICAL_SPACE,
};
use rivet_store::{
    fuse_event_id_arms_boosted, hybrid_fetch_limit, prefer_lexical_query, ClickHouseTrafficStore,
    JobStatus, MetaStore, NatsJobStore, QueueStats, SessionBinding, TopicMeta, TrafficStore,
    WikiPageMeta, WorkerRole,
};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;
use tower_http::cors::{AllowOrigin, CorsLayer};

/// Process / sidecar control implemented by `rivet-runtime`.
pub trait ControlApi: Send + Sync {
    fn proxy_running(&self) -> bool;
    fn proxy_start(&self) -> Result<(), String>;
    fn proxy_stop(&self) -> Result<(), String>;
    fn login_start(
        &self,
        provider: &str,
        method: Option<&str>,
    ) -> Result<LoginStartResponse, String>;
    fn login_status(&self) -> LoginStatusResponse;
    fn login_cancel(&self) -> Result<(), String>;
    fn list_accounts(&self) -> Result<Vec<AccountInfo>, String>;
    fn remove_account(&self, id: &str) -> Result<(), String>;
    fn write_harness(
        &self,
        target: &str,
        mode: Option<&str>,
    ) -> Result<HarnessWriteResponse, String>;
    fn import_vertex(&self, path: &str) -> Result<LoginStartResponse, String>;
}

#[derive(Clone)]
pub struct ApiState {
    pub config: Arc<RwLock<RivetConfig>>,
    pub store: Arc<dyn TrafficStore>,
    /// `ClickHouse` client used for HNSW vector search / embedding counts.
    pub ch: Arc<ClickHouseTrafficStore>,
    /// NATS `JetStream` job plane.
    pub jobs: Arc<NatsJobStore>,
    pub control: Arc<dyn ControlApi>,
    pub paths: RivetPaths,
    pub meta: Arc<MetaStore>,
    /// Traffic backend id — currently always `clickhouse`.
    pub traffic_backend: &'static str,
    /// Background vectorize + wiki workers.
    pub workers: Option<Arc<rivet_worker::WorkerPool>>,
    /// Bumped whenever the wiki filesystem index changes.
    pub wiki_revision: Arc<AtomicU64>,
    /// In-process live refresh bus (wiki/traffic SSE).
    pub live: LiveBus,
    /// Signal rivetd to exit after sidecars stop (`POST /v1/shutdown`).
    pub shutdown: tokio::sync::watch::Sender<bool>,
}

impl std::fmt::Debug for ApiState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ApiState")
            .field("paths", &self.paths)
            .field("traffic_backend", &self.traffic_backend)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct StatusResponse {
    pub ok: bool,
    pub proxy_running: bool,
    pub proxy_base_url: String,
    pub mcp_url: String,
    pub access_key_hint: String,
    pub capabilities: Capabilities,
    pub usage: UsageTotals,
    pub account_count: u64,
    #[schema(value_type = String)]
    pub traffic_backend: &'static str,
    pub wiki_dir: String,
    pub embedding_model: Option<String>,
    pub wiki_model: Option<String>,
    /// Soft warnings for the desktop UI (port conflicts, onboarding hints).
    pub warnings: Vec<String>,
    pub onboarding: OnboardingStatus,
    pub workers: WorkersStatus,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct WorkersStatus {
    pub vector_search: bool,
    pub wiki: bool,
    pub embeddings: u64,
    pub wiki_pages: u64,
    pub vectorize_cursor: Option<String>,
    pub wiki_cursor: Option<String>,
    /// Role this process claims (`RIVET_WORKER_ROLE`).
    pub role: String,
    #[schema(value_type = Object)]
    pub queue: QueueStats,
}

#[allow(clippy::struct_excessive_bools)] // Desktop onboarding checklist flags map to UI steps.
#[derive(Debug, Copy, Clone, Serialize, utoipa::ToSchema)]
pub struct OnboardingStatus {
    pub proxy_running: bool,
    pub has_accounts: bool,
    pub has_traffic: bool,
    pub harness_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct AccountInfo {
    pub id: String,
    pub provider: String,
    pub label: String,
    pub limit_hint: String,
    pub reset_hint: String,
}

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub provider: String,
    /// Optional login method override (`browser` / `device`) for providers that support both.
    #[serde(default)]
    pub method: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LoginStartResponse {
    pub provider: String,
    pub message: String,
    pub hint: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LoginStatusResponse {
    pub active: bool,
    pub provider: Option<String>,
    pub output: String,
    pub done: bool,
    pub success: bool,
}

#[derive(Debug, Deserialize)]
pub struct HarnessWriteRequest {
    pub target: String,
    /// `user` (default) overlays the real Claude/Codex config with a backup.
    /// `isolated` writes under Rivet's harness dir (requires env override).
    #[serde(default)]
    pub mode: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct HarnessSessionRequest {
    pub session_id: String,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct HarnessSessionQuery {
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct HarnessWriteResponse {
    pub target: String,
    pub path: String,
    pub env_hint: String,
    pub note: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup_path: Option<String>,
    /// `user` or `isolated`
    pub mode: String,
}

#[derive(Debug, Deserialize)]
pub struct ImportRequest {
    pub path: String,
}

#[derive(Debug, Deserialize)]
pub struct LocalIngestRequest {
    /// `claude`, `codex`, `cursor`, or omit / empty for all.
    #[serde(default)]
    pub sources: Vec<String>,
    pub claude_root: Option<String>,
    pub codex_root: Option<String>,
    pub cursor_root: Option<String>,
    #[serde(default)]
    pub dry_run: bool,
    pub limit: Option<usize>,
}

#[derive(Debug, Serialize)]
pub struct ExportResponse {
    pub path: String,
    pub event_count: u64,
    pub note: String,
}

#[derive(Debug, Serialize)]
pub struct ImportResponse {
    pub path: String,
    pub event_count: u64,
    pub schema_version: u32,
}

#[derive(Debug, Deserialize)]
pub struct ConfigUpdate {
    pub embedding_model: Option<String>,
    pub wiki_model: Option<String>,
    pub wiki_project_id: Option<String>,
    pub capabilities: Option<CapabilitiesPatch>,
}

#[derive(Debug, Copy, Clone, Deserialize)]
pub struct CapabilitiesPatch {
    pub vector_search: Option<bool>,
    pub wiki: Option<bool>,
    pub teams: Option<bool>,
}

#[derive(Serialize)]
struct ErrBody {
    error: String,
}

/// Config returned to the UI — never includes live secrets.
#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
pub struct PublicConfig {
    pub proxy_port: u16,
    pub api_port: u16,
    pub mcp_port: u16,
    pub clickhouse_http_port: u16,
    pub clickhouse_native_port: u16,
    pub access_key_hint: String,
    pub management_configured: bool,
    pub capabilities: Capabilities,
    pub embedding_model: Option<String>,
    pub wiki_model: Option<String>,
    pub wiki_project_id: String,
}

fn public_config(cfg: &RivetConfig) -> PublicConfig {
    let key = &cfg.proxy_access_key;
    let hint = if key.len() > 12 {
        format!("{}…{}", &key[..8], &key[key.len() - 4..])
    } else {
        "***".into()
    };
    PublicConfig {
        proxy_port: cfg.proxy_port,
        api_port: cfg.api_port,
        mcp_port: cfg.mcp_port,
        clickhouse_http_port: cfg.clickhouse_http_port,
        clickhouse_native_port: cfg.clickhouse_native_port,
        access_key_hint: hint,
        management_configured: !cfg.management_secret.trim().is_empty(),
        capabilities: cfg.capabilities,
        embedding_model: cfg.embedding_model.clone(),
        wiki_model: cfg.wiki_model.clone(),
        wiki_project_id: cfg.wiki_project_id.clone(),
    }
}

fn sanitize_wiki_project_id(raw: &str) -> Result<String, String> {
    let s = raw.trim();
    if s.is_empty() {
        return Err("wiki_project_id empty".into());
    }
    if s.len() > 64
        || s.contains("..")
        || s.contains('/')
        || s.contains('\\')
        || !s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err("wiki_project_id must be a short path-safe id (letters, digits, .-_)".into());
    }
    Ok(s.to_string())
}

fn localhost_cors() -> CorsLayer {
    use axum::http::{HeaderName, Method};
    CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(|origin, _| {
            origin.to_str().is_ok_and(rivet_core::origin_allowed)
        }))
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::DELETE, Method::OPTIONS])
        .allow_headers([
            header::CONTENT_TYPE,
            header::AUTHORIZATION,
            HeaderName::from_static("x-rivet-key"),
        ])
        .allow_credentials(false)
        .max_age(std::time::Duration::from_secs(600))
        .expose_headers([HeaderName::from_static("x-rivet-key")])
}

fn host_is_loopback(headers: &HeaderMap) -> bool {
    headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .is_some_and(rivet_core::host_is_loopback)
}

fn extract_api_key(headers: &HeaderMap) -> Option<String> {
    if let Some(v) = headers.get("x-rivet-key").and_then(|v| v.to_str().ok()) {
        return Some(v.trim().to_string());
    }
    if let Some(v) = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()) {
        let v = v.trim();
        if let Some(rest) = v.strip_prefix("Bearer ").or_else(|| v.strip_prefix("bearer ")) {
            return Some(rest.trim().to_string());
        }
    }
    None
}

async fn require_api_key(
    State(state): State<ApiState>,
    req: Request<axum::body::Body>,
    next: Next,
) -> Result<Response, (StatusCode, Json<ErrBody>)> {
    if !host_is_loopback(req.headers()) {
        return Err(err_response("control API only accepts Host: 127.0.0.1 / localhost".into()));
    }
    let expected = state.config.read().await.proxy_access_key.clone();
    let provided = extract_api_key(req.headers()).unwrap_or_default();
    if provided.is_empty() || provided != expected {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(ErrBody {
                error: "missing or invalid X-Rivet-Key (GET /v1/session on localhost)".into(),
            }),
        ));
    }
    Ok(next.run(req).await)
}

async fn require_loopback_host(
    req: Request<axum::body::Body>,
    next: Next,
) -> Result<Response, (StatusCode, Json<ErrBody>)> {
    if !host_is_loopback(req.headers()) {
        return Err(err_response("control API only accepts Host: 127.0.0.1 / localhost".into()));
    }
    Ok(next.run(req).await)
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct LocalSession {
    pub api_key: String,
    #[schema(value_type = String)]
    pub note: &'static str,
}

async fn local_session(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<LocalSession>, (StatusCode, Json<ErrBody>)> {
    if !host_is_loopback(&headers) {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ErrBody { error: "session bootstrap is localhost-only".into() }),
        ));
    }
    let key = state.config.read().await.proxy_access_key.clone();
    Ok(Json(LocalSession {
        api_key: key,
        note: "Use X-Rivet-Key on mutating control routes. Never export this value.",
    }))
}

pub fn router(state: ApiState) -> Router {
    // Bootstrap-only: status + session. Everything else needs X-Rivet-Key.
    let public = Router::new()
        .route("/v1/status", get(status))
        .route("/v1/session", get(local_session))
        .route("/v1/openapi.json", get(openapi_json))
        .route("/v1/live", get(live_cursor_doc))
        .route_layer(middleware::from_fn(require_loopback_host));

    let protected = Router::new()
        .route("/v1/events", get(live_events_doc))
        .route("/v1/config", get(get_config).put(put_config))
        .route("/v1/traffic/recent", get(recent))
        .route("/v1/traffic/search", get(search_traffic))
        .route("/v1/conversations", get(list_conversations))
        .route("/v1/conversations/search", get(search_conversations))
        .route("/v1/conversations/events", get(conversation_events))
        .route("/v1/providers", get(list_providers))
        .route("/v1/accounts", get(accounts))
        .route("/v1/accounts/login/status", get(login_status))
        .route("/v1/quota", get(quota_snapshot))
        .route("/v1/quota/history", get(quota_history))
        .route("/v1/wiki", get(wiki_info))
        .route("/v1/wiki/page", get(wiki_page))
        .route("/v1/wiki/archives", get(wiki_archives))
        .route("/v1/wiki/archive", get(wiki_archive_file))
        .route("/v1/topics", get(topics_list).post(topic_curate))
        .route("/v1/topics/item", get(topic_get))
        .route("/v1/topics/tidy", get(tidy_list).post(tidy_decide))
        .route("/v1/topics/tags", get(tags_list).post(tags_decide))
        .route("/v1/memory/startup", get(memory_startup).post(memory_startup_post))
        .route("/v1/workers/flagged", get(workers_flagged).post(workers_flagged_retry))
        .route("/v1/summaries", get(summaries_list))
        .route("/v1/traffic/full", get(traffic_get_full))
        .route("/v1/conversations/browse", get(conversation_browse))
        .route("/v1/memory/stats", get(memory_stats))
        .route("/v1/harness/claude.env", get(claude_env))
        .route("/v1/harness/codex.toml", get(codex_toml))
        .route("/v1/harness/mcp.json", get(mcp_json))
        .route("/v1/logs/{kind}", get(tail_logs))
        .route("/v1/demo/seed", post(demo_seed))
        .route("/v1/harness/write", post(harness_write))
        .route(
            "/v1/harness/session",
            post(harness_session).get(harness_session_get).delete(harness_session_delete),
        )
        .route("/v1/proxy/start", post(proxy_start))
        .route("/v1/proxy/stop", post(proxy_stop))
        .route("/v1/shutdown", post(shutdown_all))
        .route("/v1/accounts/{id}", delete(account_delete))
        .route("/v1/accounts/login", post(login_start))
        .route("/v1/accounts/login/cancel", post(login_cancel))
        .route("/v1/accounts/import/vertex", post(import_vertex))
        .route("/v1/quota/refresh", post(quota_refresh))
        .route("/v1/export", post(export_bag))
        .route("/v1/import", post(import_bag))
        .route("/v1/ingest/local", post(ingest_local))
        .route("/v1/workers/tick", post(workers_tick))
        .route("/v1/workers/queue", get(workers_queue))
        .route_layer(middleware::from_fn_with_state(state.clone(), require_api_key));

    public.merge(protected).layer(localhost_cors()).with_state(state)
}

#[utoipa::path(
    get,
    path = "/v1/openapi.json",
    tag = "control",
    responses((status = 200, description = "OpenAPI 3 document for the control API"))
)]
pub async fn openapi_json() -> Json<utoipa::openapi::OpenApi> {
    use utoipa::OpenApi;
    Json(openapi::ApiDoc::openapi())
}

#[utoipa::path(
    get,
    path = "/v1/live",
    tag = "live",
    responses((status = 200, description = "Live refresh cursor", body = rivet_core::LiveCursor))
)]
pub async fn live_cursor_doc(state: State<ApiState>) -> Json<rivet_core::LiveCursor> {
    live_routes::live_cursor(state).await
}

#[utoipa::path(
    get,
    path = "/v1/events",
    tag = "live",
    responses((
        status = 200,
        description = "Server-Sent Events stream (`text/event-stream`) of live bus updates"
    ))
)]
pub async fn live_events_doc(state: State<ApiState>) -> Response {
    live_routes::live_sse(state).await.into_response()
}

#[utoipa::path(
    get,
    path = "/v1/status",
    tag = "control",
    responses((status = 200, description = "Control plane status", body = StatusResponse))
)]
pub async fn status(State(state): State<ApiState>) -> Json<StatusResponse> {
    let usage = state.store.usage_totals().await.unwrap_or_default();
    let proxy_running = state.control.proxy_running();
    let (
        proxy_port,
        proxy_base_url,
        mcp_url,
        access_key_hint,
        capabilities,
        embedding_model,
        wiki_model,
        wiki_project_id,
    ) = {
        let cfg = state.config.read().await;
        let key = &cfg.proxy_access_key;
        let hint = if key.len() > 12 {
            format!("{}…{}", &key[..8], &key[key.len() - 4..])
        } else {
            "***".into()
        };
        (
            cfg.proxy_port,
            cfg.proxy_base_url(),
            cfg.mcp_url(),
            hint,
            cfg.capabilities,
            cfg.embedding_model.clone(),
            cfg.wiki_model.clone(),
            cfg.wiki_project_id.clone(),
        )
    };
    let account_count = state.control.list_accounts().map_or(0, |a| a.len() as u64);
    let mut warnings = Vec::new();
    if !proxy_running && !localhost_port_free(proxy_port) {
        warnings.push(format!(
            "Proxy port {proxy_port} is already in use by another process — stop it or change proxy_port in config.json"
        ));
    }
    let harness_ready = harness_user_ready()
        || state.paths.harness_claude_dir().join("settings.json").exists()
        || state.paths.harness_codex_dir().join("config.toml").exists();
    let embeddings = state.ch.embedding_count(LEXICAL_SPACE).await.unwrap_or(0);
    let queue = state.jobs.queue_stats().await.unwrap_or(QueueStats {
        pending: 0,
        running: 0,
        done: 0,
        failed: 0,
        dead: 0,
    });
    Json(StatusResponse {
        ok: true,
        proxy_running,
        proxy_base_url,
        mcp_url,
        access_key_hint,
        capabilities,
        usage,
        account_count,
        traffic_backend: state.traffic_backend,
        wiki_dir: state.paths.wiki_dir().to_string(),
        embedding_model,
        wiki_model,
        warnings,
        onboarding: OnboardingStatus {
            proxy_running,
            has_accounts: account_count > 0,
            has_traffic: usage.events > 0,
            harness_ready,
        },
        workers: WorkersStatus {
            vector_search: capabilities.vector_search,
            wiki: capabilities.wiki,
            embeddings,
            wiki_pages: state.meta.wiki_page_count(&wiki_project_id).unwrap_or(0),
            vectorize_cursor: state.meta.job_cursor("vectorize").ok().flatten(),
            wiki_cursor: state.meta.job_cursor("wiki").ok().flatten(),
            role: WorkerRole::from_env().as_str().to_string(),
            queue,
        },
    })
}

#[utoipa::path(
    get,
    path = "/v1/config",
    tag = "control",
    responses((status = 200, description = "Public config", body = PublicConfig))
)]
pub async fn get_config(State(state): State<ApiState>) -> Json<PublicConfig> {
    let cfg = state.config.read().await;
    Json(public_config(&cfg))
}

async fn put_config(
    State(state): State<ApiState>,
    Json(body): Json<ConfigUpdate>,
) -> Result<Json<PublicConfig>, (StatusCode, Json<ErrBody>)> {
    let mut cfg = state.config.write().await;
    if let Some(m) = body.embedding_model {
        cfg.embedding_model = if m.trim().is_empty() { None } else { Some(m) };
    }
    if let Some(m) = body.wiki_model {
        cfg.wiki_model = if m.trim().is_empty() { None } else { Some(m) };
    }
    if let Some(p) = body.wiki_project_id {
        if !p.trim().is_empty() {
            cfg.wiki_project_id = sanitize_wiki_project_id(&p).map_err(err_response)?;
        }
    }
    // Models arm capabilities; explicit capability flags win afterward.
    cfg.sync_capabilities_from_models();
    if let Some(caps) = body.capabilities {
        if let Some(v) = caps.vector_search {
            cfg.capabilities.vector_search = v;
        }
        if let Some(v) = caps.wiki {
            cfg.capabilities.wiki = v;
        }
        if let Some(v) = caps.teams {
            cfg.capabilities.teams = v;
        }
    }
    cfg.save(&state.paths).map_err(|e| err_response(e.to_string()))?;
    let response = public_config(&cfg);
    drop(cfg);
    Ok(Json(response))
}

#[derive(Debug, Deserialize)]
pub struct TrafficQuery {
    limit: Option<u32>,
    q: Option<String>,
}

#[utoipa::path(
    get,
    path = "/v1/traffic/recent",
    tag = "traffic",
    responses((status = 200, description = "Recent traffic events", body = Vec<TrafficEvent>))
)]
pub async fn recent(
    State(state): State<ApiState>,
    Query(q): Query<TrafficQuery>,
) -> Result<Json<Vec<TrafficEvent>>, StatusCode> {
    let limit = q.limit.unwrap_or(200).min(500);
    if let Some(query) = q.q.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        return state
            .store
            .search_keyword(query, limit)
            .await
            .map(Json)
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR);
    }
    state.store.recent(limit).await.map(Json).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

async fn search_traffic(
    State(state): State<ApiState>,
    Query(q): Query<TrafficQuery>,
) -> Result<Json<Vec<TrafficEvent>>, StatusCode> {
    let limit = q.limit.unwrap_or(100).min(500);
    let query = q.q.unwrap_or_default();
    if query.trim().is_empty() {
        return state
            .store
            .recent(limit)
            .await
            .map(Json)
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR);
    }
    state
        .store
        .search_keyword(&query, limit)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

#[derive(Debug, Deserialize)]
struct ConversationQuery {
    limit: Option<u32>,
    q: Option<String>,
    /// `keyword` (default), `vector` / `semantic`, or `hybrid`.
    mode: Option<String>,
    id: Option<String>,
}

#[derive(Serialize)]
struct ConversationSearchResponse {
    mode: &'static str,
    results: Vec<ConversationSummary>,
}

async fn list_conversations(
    State(state): State<ApiState>,
    Query(q): Query<ConversationQuery>,
) -> Result<Json<Vec<ConversationSummary>>, StatusCode> {
    let limit = q.limit.unwrap_or(100).min(500);
    state
        .store
        .list_conversations(limit)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

async fn conversation_events(
    State(state): State<ApiState>,
    Query(q): Query<ConversationQuery>,
) -> Result<Json<Vec<TrafficEvent>>, StatusCode> {
    let limit = q.limit.unwrap_or(500).min(2000);
    let id = q.id.unwrap_or_default();
    if id.trim().is_empty() {
        return Ok(Json(Vec::new()));
    }
    let mut events = state
        .store
        .conversation_events(&id, limit)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    // Soft→wire: also pull events still keyed by the soft fingerprint.
    if let Ok(aliases) = state.meta.soft_aliases_for_wire(id.trim()) {
        for soft in aliases {
            if let Ok(more) = state.store.conversation_events(&soft, limit).await {
                events.extend(more);
            }
        }
        events.sort_by_key(|e| e.ts);
        events.dedup_by_key(|e| e.id);
        if events.len() > limit as usize {
            events.truncate(limit as usize);
        }
    }
    // Expand spilled full bodies so the transcript UI is not limited to the preview.
    rivet_core::hydrate_events(&state.paths, &mut events);
    Ok(Json(events))
}

async fn search_conversations(
    State(state): State<ApiState>,
    Query(q): Query<ConversationQuery>,
) -> Result<Json<ConversationSearchResponse>, StatusCode> {
    let limit = q.limit.unwrap_or(100).min(500);
    let query = q.q.unwrap_or_default();
    if query.trim().is_empty() {
        let results = state
            .store
            .list_conversations(limit)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        return Ok(Json(ConversationSearchResponse { mode: "list", results }));
    }

    let vector_on = state.config.read().await.capabilities.vector_search;
    let mode = q.mode.as_deref().unwrap_or("keyword");
    let want_vector = matches!(mode, "vector" | "semantic");
    let want_hybrid = matches!(mode, "hybrid" | "rrf");

    if want_hybrid {
        if !vector_on {
            return Err(StatusCode::NOT_FOUND);
        }
        match hybrid_conversation_search(&state, &query, limit).await {
            Ok((mode, results)) => {
                return Ok(Json(ConversationSearchResponse { mode, results }));
            },
            Err(_) => return Err(StatusCode::INTERNAL_SERVER_ERROR),
        }
    }

    if want_vector {
        if !vector_on {
            return Err(StatusCode::NOT_FOUND);
        }
        match semantic_conversation_search(&state, &query, limit).await {
            Ok((mode, results)) => {
                return Ok(Json(ConversationSearchResponse { mode, results }));
            },
            Err(_) => return Err(StatusCode::INTERNAL_SERVER_ERROR),
        }
    }

    let results = state
        .store
        .search_conversations(&query, limit)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(ConversationSearchResponse { mode: "keyword", results }))
}

async fn semantic_conversation_search(
    state: &ApiState,
    query: &str,
    limit: u32,
) -> Result<(&'static str, Vec<ConversationSummary>), String> {
    let query_vec = lexical_embed(query);
    // Overscan so conversation projection still has enough distinct sessions.
    let fetch = limit.saturating_mul(4).max(limit);
    let hits = state
        .ch
        .search_embeddings(LEXICAL_SPACE, &query_vec, fetch)
        .await
        .map_err(|e| e.to_string())?;

    // cosineDistance on unit vectors: similarity ≈ 1 - distance. Keep weak hits out.
    let scored: Vec<(f32, String)> = hits
        .into_iter()
        .map(|h| (1.0 - h.distance, h.event_id))
        .filter(|(score, _)| *score > 0.05)
        .collect();

    if scored.is_empty() {
        let results =
            state.store.search_conversations(query, limit).await.map_err(|e| e.to_string())?;
        return Ok(("keyword_fallback", results));
    }

    let ids: Vec<String> = scored.iter().map(|(_, id)| id.clone()).collect();
    let found = state.store.get_by_ids(&ids).await.map_err(|e| e.to_string())?;
    // Preserve score order when projecting to conversations.
    let mut by_id = HashMap::new();
    for event in &found {
        by_id.insert(event.id.to_string(), event);
    }
    let mut ordered = Vec::new();
    for (_score, id) in &scored {
        if let Some(event) = by_id.remove(id) {
            ordered.push(event.clone());
        }
    }
    // Pull full sessions for hit events so the list shows conversation context.
    let mut seen = std::collections::HashSet::new();
    let mut expanded = Vec::new();
    for ev in &ordered {
        let cid = ev.conversation_id();
        if !seen.insert(cid.clone()) {
            continue;
        }
        let session = state.store.conversation_events(&cid, 200).await.unwrap_or_default();
        if session.is_empty() {
            expanded.push(ev.clone());
        } else {
            expanded.extend(session);
        }
    }
    Ok(("vector", conversations_from_events(&expanded, limit.max(1))))
}

async fn hybrid_conversation_search(
    state: &ApiState,
    query: &str,
    limit: u32,
) -> Result<(&'static str, Vec<ConversationSummary>), String> {
    let fetch = hybrid_fetch_limit(limit);
    let keyword = state.store.search_keyword(query, fetch).await.map_err(|e| e.to_string())?;
    let keyword_ids: Vec<String> = keyword.iter().map(|e| e.id.to_string()).collect();
    // Prefer lexical when the query looks like a path / id.
    if prefer_lexical_query(query) && !keyword_ids.is_empty() {
        return Ok(("hybrid_lexical", conversations_from_events(&keyword, limit.max(1))));
    }
    let query_vec = lexical_embed(query);
    let hits = state
        .ch
        .search_embeddings(LEXICAL_SPACE, &query_vec, fetch)
        .await
        .map_err(|e| e.to_string())?;
    let vector_ids: Vec<String> = hits
        .into_iter()
        .filter(|h| 1.0 - h.distance > 0.05)
        .map(|h| strip_chunk_suffix(&h.event_id))
        .collect();
    if keyword_ids.is_empty() && vector_ids.is_empty() {
        let results =
            state.store.search_conversations(query, limit).await.map_err(|e| e.to_string())?;
        return Ok(("keyword_fallback", results));
    }
    // Summary lineage: treat summary event_ids as summary-sourced for RRF bonus.
    let summary_ids: Vec<String> = state
        .meta
        .list_summaries()
        .unwrap_or_default()
        .into_iter()
        .flat_map(|s| s.event_ids)
        .collect();
    let mut boosts = HashMap::new();
    let access = state
        .meta
        .access_counts_for(
            &keyword_ids.iter().chain(vector_ids.iter()).cloned().collect::<Vec<_>>(),
        )
        .unwrap_or_default();
    for ev in &keyword {
        let age = age_days_since(ev.ts);
        let n = access.get(&ev.id.to_string()).copied().unwrap_or(0);
        boosts.insert(ev.id.to_string(), recency_boost(age, n, 0.2));
    }
    let fused_ids = fuse_event_id_arms_boosted(
        &keyword_ids,
        &vector_ids,
        &summary_ids,
        &boosts,
        limit.saturating_mul(4),
    );
    for id in &fused_ids {
        let _ = state.meta.bump_access(id);
    }
    let found = state.store.get_by_ids(&fused_ids).await.map_err(|e| e.to_string())?;
    let mut by_id = HashMap::new();
    for event in &found {
        by_id.insert(event.id.to_string(), event);
    }
    let mut ordered = Vec::new();
    for id in &fused_ids {
        if let Some(event) = by_id.remove(id) {
            ordered.push(event.clone());
        }
    }
    // Auto-expand: walk summary DAG lineage for fused hits (siblings + child events).
    let seed_ids: Vec<String> = ordered.iter().map(|e| e.id.to_string()).collect();
    if let Ok(extra) = state.meta.expand_events_via_lineage(&seed_ids, 24) {
        let missing: Vec<String> =
            extra.into_iter().filter(|id| !fused_ids.iter().any(|f| f == id)).collect();
        if !missing.is_empty() {
            if let Ok(more) = state.store.get_by_ids(&missing).await {
                ordered.extend(more);
            }
        }
    }
    let mut seen = std::collections::HashSet::new();
    let mut expanded = Vec::new();
    for ev in &ordered {
        let cid = ev.conversation_id();
        if !seen.insert(cid.clone()) {
            continue;
        }
        let session = state.store.conversation_events(&cid, 200).await.unwrap_or_default();
        if session.is_empty() {
            expanded.push(ev.clone());
        } else {
            expanded.extend(session);
        }
    }
    Ok(("hybrid", conversations_from_events(&expanded, limit.max(1))))
}

fn strip_chunk_suffix(event_id: &str) -> String {
    event_id.split("#c").next().unwrap_or(event_id).to_string()
}

#[derive(Debug, Deserialize)]
struct DemoSeedRequest {
    /// When true, seed even if traffic already exists.
    force: Option<bool>,
}

#[derive(Serialize)]
struct DemoSeedResponse {
    inserted: u64,
    note: String,
}

async fn demo_seed(
    State(state): State<ApiState>,
    Json(body): Json<DemoSeedRequest>,
) -> Result<Json<DemoSeedResponse>, (StatusCode, Json<ErrBody>)> {
    let usage = state.store.usage_totals().await.map_err(|e| err_response(e.to_string()))?;
    if usage.events > 0 && !body.force.unwrap_or(false) {
        return Ok(Json(DemoSeedResponse {
            inserted: 0,
            note: "store already has traffic — pass {\"force\":true} to append demo events".into(),
        }));
    }

    let events = build_demo_events();
    let n = events.len() as u64;
    state.store.insert_batch(&events).await.map_err(|e| err_response(e.to_string()))?;
    Ok(Json(DemoSeedResponse {
        inserted: n,
        note: "Demo traffic seeded for local product walkthrough (no credentials).".into(),
    }))
}

fn build_demo_events() -> Vec<TrafficEvent> {
    let samples: &[(&str, ProviderKind, &str, TrafficRole, u32, u32)] = &[
        (
            "Refactor the auth middleware to support device codes.",
            ProviderKind::Claude,
            "claude-sonnet-4-5",
            TrafficRole::User,
            420,
            0,
        ),
        (
            "Sure — here's a sketch using PKCE and a short-lived device code…",
            ProviderKind::Claude,
            "claude-sonnet-4-5",
            TrafficRole::Assistant,
            0,
            1860,
        ),
        (
            "Write a failing test for rivetbag export excluding oauth dirs.",
            ProviderKind::Codex,
            "gpt-5-codex",
            TrafficRole::User,
            310,
            0,
        ),
        (
            "Added `export_excludes_credentials` covering Application Support paths.",
            ProviderKind::Codex,
            "gpt-5-codex",
            TrafficRole::Assistant,
            0,
            1420,
        ),
        (
            "Summarize last hour of proxy errors for Claude pool.",
            ProviderKind::Claude,
            "claude-haiku-4-5",
            TrafficRole::User,
            180,
            0,
        ),
        (
            "Three 429s from anthropic, one timeout; burn ~12k tokens.",
            ProviderKind::Claude,
            "claude-haiku-4-5",
            TrafficRole::Assistant,
            0,
            640,
        ),
        (
            "Generate harness MCP snippet for Rivet history search.",
            ProviderKind::Codex,
            "gpt-5-codex",
            TrafficRole::User,
            220,
            0,
        ),
        (
            "```json\n{\"mcpServers\":{\"rivet\":{\"url\":\"http://127.0.0.1:8742/mcp\"}}}\n```",
            ProviderKind::Codex,
            "gpt-5-codex",
            TrafficRole::Assistant,
            0,
            380,
        ),
    ];

    let mut out = Vec::new();
    let now = Utc::now();
    for i in 0..36 {
        let (content, provider, model, role, tin, tout) = samples[i % samples.len()];
        let mins_ago = (i64::try_from(i).unwrap_or(0) + 1) * 7;
        let mut ev = TrafficEvent::new(provider);
        ev.ts = now - Duration::minutes(mins_ago);
        ev.model = Some(model.into());
        ev.role = role;
        ev.content = Some(content.into());
        let idx = u32::try_from(i).unwrap_or(0);
        ev.tokens_in = tin + ((idx % 5) * 17);
        ev.tokens_out = tout + ((idx % 7) * 23);
        ev.latency_ms = Some(400 + (u64::from(idx % 12)) * 85);
        ev.status_code = Some(if i % 11 == 0 { 429 } else { 200 });
        ev.account_label = Some(if matches!(provider, ProviderKind::Claude) {
            "claude-primary".into()
        } else {
            "codex-work".into()
        });
        ev.session_id = Some(format!("demo-session-{}", i / 4));
        ev.capture_quality = Some(rivet_core::CaptureQuality::Wire);
        out.push(ev);
    }
    out
}

async fn claude_env(State(state): State<ApiState>) -> String {
    let cfg = state.config.read().await;
    claude_settings_json(&cfg)
}

async fn codex_toml(State(state): State<ApiState>) -> String {
    let cfg = state.config.read().await;
    codex_config_toml(&cfg)
}

async fn mcp_json(State(state): State<ApiState>) -> String {
    let cfg = state.config.read().await;
    claude_mcp_json(&cfg)
}

async fn proxy_start(
    State(state): State<ApiState>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrBody>)> {
    state.control.proxy_start().map_err(err_response)?;
    Ok(Json(serde_json::json!({ "ok": true, "proxy_running": true })))
}

async fn proxy_stop(
    State(state): State<ApiState>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrBody>)> {
    state.control.proxy_stop().map_err(err_response)?;
    Ok(Json(serde_json::json!({ "ok": true, "proxy_running": false })))
}

async fn shutdown_all(
    State(state): State<ApiState>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrBody>)> {
    let proxy_ok = state.control.proxy_stop();
    let _ = state.shutdown.send(true);
    Ok(Json(serde_json::json!({
        "ok": true,
        "proxy_stopped": proxy_ok.is_ok(),
        "proxy_error": proxy_ok.err(),
        "note": "runtime shutdown signaled; sidecars stop on process exit"
    })))
}

async fn accounts(
    State(state): State<ApiState>,
) -> Result<Json<Vec<AccountInfo>>, (StatusCode, Json<ErrBody>)> {
    let mut accounts = state.control.list_accounts().map_err(err_response)?;
    // Prefer live management signals for limit/reset hints when the proxy is up.
    if let Ok(snap) = build_quota_snapshot(&state).await {
        for acct in &mut accounts {
            if let Some(q) = snap.accounts.iter().find(|a| {
                a.id == acct.id
                    || a.id.ends_with(&acct.id)
                    || a.id.contains(&format!("{}.json", acct.id))
                    || a.label == acct.label
                    || a.email.as_deref() == Some(acct.label.as_str())
                    || a.email.as_deref() == Some(acct.id.as_str())
            }) {
                if let Some(email) = &q.email {
                    acct.label = email.clone();
                }
                acct.limit_hint = q
                    .remaining_pct
                    .map_or_else(|| "— pending live".into(), |p| format!("{p:.0}% left"));
                acct.reset_hint = q
                    .reset_at
                    .clone()
                    .map(|r| format_account_reset(&r))
                    .or_else(|| q.cooldown_seconds.map(|s| format!("cooldown {s}s")))
                    .unwrap_or_else(|| "—".into());
            }
        }
    }
    Ok(Json(accounts))
}

async fn quota_snapshot(
    State(state): State<ApiState>,
) -> Result<Json<quota::QuotaSnapshot>, (StatusCode, Json<ErrBody>)> {
    build_quota_snapshot(&state).await.map(Json).map_err(err_response)
}

async fn quota_refresh(
    State(state): State<ApiState>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrBody>)> {
    let cfg = state.config.read().await.clone();
    let refreshed =
        quota::refresh_credentials(&cfg).await.map_err(|e| err_response(e.to_string()))?;
    let snap = build_quota_snapshot(&state).await.map_err(err_response)?;
    Ok(Json(serde_json::json!({
        "ok": true,
        "refresh": refreshed,
        "quota": snap,
    })))
}

async fn build_quota_snapshot(state: &ApiState) -> Result<quota::QuotaSnapshot, String> {
    let cfg = state.config.read().await.clone();
    let burn = burn_by_provider(state).await;
    let snap = match quota::fetch_quota_snapshot(&cfg, &burn).await {
        Ok(snap) => snap,
        Err(err) => {
            tracing::debug!(error = %err, "quota management fetch failed; using local fallback");
            let local = state
                .control
                .list_accounts()
                .unwrap_or_default()
                .into_iter()
                .map(|a| (a.id, a.provider, a.label))
                .collect::<Vec<_>>();
            quota::local_fallback_snapshot(&local, &burn)
        },
    };
    record_quota_history(state, &snap);
    Ok(snap)
}

fn record_quota_history(state: &ApiState, snap: &quota::QuotaSnapshot) {
    let rows: Vec<rivet_store::QuotaSnapshotInsert> = snap
        .accounts
        .iter()
        .filter_map(|a| {
            let remaining = a.remaining_pct?;
            Some(rivet_store::QuotaSnapshotInsert {
                account_id: a.id.clone(),
                provider: rivet_core::normalize_provider_id(&a.provider),
                remaining_pct: remaining,
                reset_at: a.reset_at.clone(),
            })
        })
        .collect();
    if rows.is_empty() {
        return;
    }
    if let Err(err) = state.meta.record_quota_snapshots(&rows) {
        tracing::debug!(error = %err, "quota snapshot persist failed");
    }
}

#[derive(Debug, Deserialize)]
struct QuotaHistoryQuery {
    #[serde(default = "default_history_hours")]
    hours: u32,
}

const fn default_history_hours() -> u32 {
    6
}

#[derive(Serialize)]
struct QuotaHistoryPoint {
    ts: String,
    remaining_pct: f64,
    account_count: u64,
}

#[derive(Serialize)]
struct QuotaHistoryProvider {
    provider: String,
    points: Vec<QuotaHistoryPoint>,
}

#[derive(Serialize)]
struct QuotaHistoryResponse {
    hours: u32,
    providers: Vec<QuotaHistoryProvider>,
    note: String,
}

async fn quota_history(
    State(state): State<ApiState>,
    Query(q): Query<QuotaHistoryQuery>,
) -> Result<Json<QuotaHistoryResponse>, (StatusCode, Json<ErrBody>)> {
    let hours = q.hours.clamp(1, 168);
    let since = (Utc::now() - Duration::hours(i64::from(hours))).to_rfc3339();
    let rows = state.meta.quota_history_since(&since).map_err(|e| err_response(e.to_string()))?;

    // Bucket by provider + minute so the chart stays readable.
    let mut by_provider: HashMap<String, BTreeMap<String, (f64, u64)>> = HashMap::new();
    for row in rows {
        let provider = rivet_core::normalize_provider_id(&row.provider);
        let bucket = row.ts.get(..16).unwrap_or(row.ts.as_str()).to_string(); // YYYY-MM-DDTHH:MM
        let entry = by_provider.entry(provider).or_default().entry(bucket).or_insert((0.0, 0));
        entry.0 += row.remaining_pct;
        entry.1 += 1;
    }

    let mut providers: Vec<QuotaHistoryProvider> = by_provider
        .into_iter()
        .map(|(provider, buckets)| {
            let points = buckets
                .into_iter()
                .map(|(minute, (sum, count))| QuotaHistoryPoint {
                    ts: format!("{minute}:00Z"),
                    remaining_pct: sum,
                    account_count: count,
                })
                .collect();
            QuotaHistoryProvider { provider, points }
        })
        .collect();
    providers.sort_by(|a, b| a.provider.cmp(&b.provider));

    Ok(Json(QuotaHistoryResponse {
        hours,
        providers,
        note: "Sum of per-account remaining % sampled from the live management API.".into(),
    }))
}

async fn burn_by_provider(state: &ApiState) -> HashMap<String, f64> {
    let mut out: HashMap<String, f64> = HashMap::new();
    let Ok(events) = state.store.recent(400).await else {
        return out;
    };
    let cutoff = Utc::now() - Duration::hours(3);
    let mut earliest = Utc::now();
    for ev in &events {
        if ev.ts < cutoff {
            continue;
        }
        if ev.ts < earliest {
            earliest = ev.ts;
        }
        let provider = rivet_core::normalize_provider_id(ev.provider.as_str());
        *out.entry(provider).or_default() += f64::from(ev.tokens_in) + f64::from(ev.tokens_out);
    }
    let secs = (Utc::now() - earliest).num_seconds().max(1);
    let secs_f = f64::from(i32::try_from(secs).unwrap_or(i32::MAX));
    let hours = (secs_f / 3600.0).max(0.25);
    for v in out.values_mut() {
        *v /= hours;
    }
    out
}

fn format_account_reset(reset_at: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(reset_at).ok().map_or_else(
        || reset_at.to_string(),
        |d| d.with_timezone(&Utc).format("%a %H:%M UTC").to_string(),
    )
}

async fn account_delete(
    State(state): State<ApiState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrBody>)> {
    state.control.remove_account(&id).map_err(err_response)?;
    Ok(Json(serde_json::json!({ "ok": true, "id": id })))
}

async fn list_providers() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "providers": provider_catalog(),
        "note": "Mirrors CLIProxyAPI / prox OAuth + Vertex import catalog.",
    }))
}

async fn login_start(
    State(state): State<ApiState>,
    Json(body): Json<LoginRequest>,
) -> Result<Json<LoginStartResponse>, (StatusCode, Json<ErrBody>)> {
    state
        .control
        .login_start(&body.provider, body.method.as_deref())
        .map(Json)
        .map_err(err_response)
}

#[derive(Debug, Deserialize)]
pub struct VertexImportRequest {
    pub path: String,
}

async fn import_vertex(
    State(state): State<ApiState>,
    Json(body): Json<VertexImportRequest>,
) -> Result<Json<LoginStartResponse>, (StatusCode, Json<ErrBody>)> {
    state.control.import_vertex(&body.path).map(Json).map_err(err_response)
}

async fn login_status(State(state): State<ApiState>) -> Json<LoginStatusResponse> {
    Json(state.control.login_status())
}

async fn login_cancel(
    State(state): State<ApiState>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrBody>)> {
    state.control.login_cancel().map_err(err_response)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn harness_write(
    State(state): State<ApiState>,
    Json(body): Json<HarnessWriteRequest>,
) -> Result<Json<HarnessWriteResponse>, (StatusCode, Json<ErrBody>)> {
    state.control.write_harness(&body.target, body.mode.as_deref()).map(Json).map_err(err_response)
}

async fn harness_session(
    State(state): State<ApiState>,
    Json(body): Json<HarnessSessionRequest>,
) -> Result<Json<SessionBinding>, (StatusCode, Json<ErrBody>)> {
    let session_id = body.session_id.trim().to_string();
    if session_id.is_empty() {
        return Err(err_response("session_id required".into()));
    }
    let cwd = body
        .cwd
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(resolve_project_root)
        .filter(|s| !s.is_empty());
    let mut project_id =
        body.project_id.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
    if project_id.is_none() {
        if let Some(ref cwd) = cwd {
            project_id = project_id_from_cwd(cwd);
        }
    }
    if project_id.is_none() && cwd.is_none() {
        return Err(err_response("cwd or project_id required".into()));
    }
    let binding = SessionBinding {
        session_id,
        project_id,
        cwd,
        provider: body.provider.filter(|s| !s.trim().is_empty()),
        source: body.source.filter(|s| !s.trim().is_empty()).or_else(|| Some("plugin".into())),
        updated_at: Utc::now().to_rfc3339(),
    };
    state.meta.upsert_session_binding(binding).map(Json).map_err(|e| err_response(e.to_string()))
}

async fn harness_session_get(
    State(state): State<ApiState>,
    Query(query): Query<HarnessSessionQuery>,
) -> Result<Json<SessionBinding>, (StatusCode, Json<ErrBody>)> {
    let session_id = query.session_id.trim();
    if session_id.is_empty() {
        return Err(err_response("session_id required".into()));
    }
    match state.meta.get_session_binding(session_id) {
        Ok(Some(binding)) => Ok(Json(binding)),
        Ok(None) => Err((
            StatusCode::NOT_FOUND,
            Json(ErrBody { error: "session binding not found".into() }),
        )),
        Err(e) => Err(err_response(e.to_string())),
    }
}

async fn harness_session_delete(
    State(state): State<ApiState>,
    Query(query): Query<HarnessSessionQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrBody>)> {
    let session_id = query.session_id.trim();
    if session_id.is_empty() {
        return Err(err_response("session_id required".into()));
    }
    let removed =
        state.meta.delete_session_binding(session_id).map_err(|e| err_response(e.to_string()))?;
    Ok(Json(serde_json::json!({
        "ok": true,
        "session_id": session_id,
        "removed": removed,
    })))
}

async fn export_bag(
    State(state): State<ApiState>,
) -> Result<Json<ExportResponse>, (StatusCode, Json<ErrBody>)> {
    state.paths.ensure().map_err(|e| err_response(e.to_string()))?;
    let name = format!("rivet-export-{}.rivetbag", Utc::now().format("%Y%m%d-%H%M%S"));
    let path = state.paths.exports_dir().join(&name);
    let manifest = rivet_export::export_bag_with_paths(
        state.store.clone(),
        path.as_std_path(),
        Some(&state.paths),
    )
    .await
    .map_err(|e| err_response(e.to_string()))?;
    Ok(Json(ExportResponse {
        path: path.to_string(),
        event_count: manifest.event_count,
        note: "Credentials excluded. Package contains traffic events only.".into(),
    }))
}

async fn import_bag(
    State(state): State<ApiState>,
    Json(body): Json<ImportRequest>,
) -> Result<Json<ImportResponse>, (StatusCode, Json<ErrBody>)> {
    let path = PathBuf::from(body.path.trim());
    if !path.is_file() {
        return Err(err_response(format!("file not found: {}", path.display())));
    }
    if path.extension().and_then(|s| s.to_str()) != Some("rivetbag")
        && !path.file_name().and_then(|s| s.to_str()).unwrap_or("").ends_with(".rivetbag")
    {
        return Err(err_response(
            "expected a .rivetbag file (credentials packages are rejected)".into(),
        ));
    }
    let manifest = rivet_export::import_into_store(state.store.clone(), &path)
        .await
        .map_err(|e| err_response(e.to_string()))?;
    Ok(Json(ImportResponse {
        path: path.display().to_string(),
        event_count: manifest.event_count,
        schema_version: manifest.schema_version,
    }))
}

async fn ingest_local(
    State(state): State<ApiState>,
    Json(body): Json<LocalIngestRequest>,
) -> Result<Json<rivet_export::LocalIngestReport>, (StatusCode, Json<ErrBody>)> {
    let mut sources = Vec::new();
    for raw in &body.sources {
        match rivet_export::LocalSource::parse(raw) {
            Some(s) => sources.push(s),
            None => {
                return Err(err_response(format!(
                    "unknown source {raw:?} (expected claude, codex, or cursor)"
                )));
            },
        }
    }
    let opts = rivet_export::LocalIngestOptions {
        sources,
        claude_root: body.claude_root.filter(|s| !s.trim().is_empty()).map(PathBuf::from),
        codex_root: body.codex_root.filter(|s| !s.trim().is_empty()).map(PathBuf::from),
        cursor_root: body.cursor_root.filter(|s| !s.trim().is_empty()).map(PathBuf::from),
        dry_run: body.dry_run,
        limit: body.limit,
    };
    rivet_export::ingest_local(state.store.clone(), opts)
        .await
        .map(Json)
        .map_err(|e| err_response(e.to_string()))
}

#[derive(Serialize)]
struct WikiPageCard {
    id: String,
    project_id: String,
    title: String,
    path: String,
    relative_path: String,
    folder: String,
    updated_at: String,
    preview: String,
}

#[derive(Serialize)]
struct WikiInfo {
    path: String,
    /// Primary / configured project id (still useful for Open folder defaults).
    project_id: String,
    /// Monotonic counter — desktop polls this to detect FS sync without a Refresh button.
    revision: u64,
    pages: Vec<WikiPageCard>,
}

#[derive(Serialize)]
struct WikiPageBody {
    id: String,
    project_id: String,
    title: String,
    path: String,
    relative_path: String,
    updated_at: String,
    content: String,
}

#[derive(Debug, Deserialize)]
struct WikiPageQuery {
    /// Page id (`default/README`) or stored path (`wiki/default/README.md`).
    id: Option<String>,
    path: Option<String>,
}

#[derive(Debug, Deserialize)]
struct WikiArchiveQuery {
    /// Topic slug (e.g. `oauth-pkce`) under the wiki project.
    slug: String,
    /// Optional archive filename (`2026-01.md`). When set, returns file body.
    file: Option<String>,
    project_id: Option<String>,
}

#[derive(Serialize)]
struct WikiArchiveList {
    project_id: String,
    slug: String,
    files: Vec<String>,
}

#[derive(Serialize)]
struct WikiArchiveBody {
    project_id: String,
    slug: String,
    file: String,
    content: String,
}

fn wiki_relative_path(project: &str, stored: &str) -> String {
    let prefix = format!("wiki/{project}/");
    stored
        .strip_prefix(&prefix)
        .or_else(|| stored.strip_prefix(&format!("wiki/{project}")))
        .unwrap_or(stored)
        .trim_start_matches('/')
        .to_string()
}

fn wiki_folder(relative: &str) -> String {
    match relative.rsplit_once('/') {
        Some((dir, _)) if !dir.is_empty() => dir.to_string(),
        _ => String::new(),
    }
}

fn resolve_wiki_abs(
    paths: &RivetPaths,
    stored_path: &str,
) -> Result<PathBuf, (StatusCode, Json<ErrBody>)> {
    let root = paths.as_root().as_std_path();
    let abs = root.join(stored_path);
    let wiki = paths
        .wiki_dir()
        .as_std_path()
        .canonicalize()
        .map_err(|e| err_response(format!("wiki dir: {e}")))?;
    let canon = abs.canonicalize().map_err(|_| {
        (StatusCode::NOT_FOUND, Json(ErrBody { error: "wiki page not found".into() }))
    })?;
    if !canon.starts_with(&wiki) {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrBody { error: "wiki path escapes wiki dir".into() }),
        ));
    }
    Ok(canon)
}

const WIKI_PREVIEW_MAX_CHARS: usize = 1600;

fn read_wiki_preview(paths: &RivetPaths, stored_path: &str) -> String {
    let Ok(abs) = resolve_wiki_abs(paths, stored_path) else {
        return String::new();
    };
    let Ok(raw) = std::fs::read_to_string(&abs) else {
        return String::new();
    };
    if raw.chars().count() <= WIKI_PREVIEW_MAX_CHARS {
        return raw;
    }
    raw.chars().take(WIKI_PREVIEW_MAX_CHARS).collect::<String>() + "\n…"
}

fn page_to_card(paths: &RivetPaths, project: &str, page: WikiPageMeta) -> WikiPageCard {
    let relative_path = wiki_relative_path(project, &page.path);
    let folder = wiki_folder(&relative_path);
    let preview = read_wiki_preview(paths, &page.path);
    WikiPageCard {
        id: page.id,
        project_id: page.project_id,
        title: page.title,
        path: page.path,
        relative_path,
        folder,
        updated_at: page.updated_at,
        preview,
    }
}

async fn wiki_info(
    State(state): State<ApiState>,
) -> Result<Json<WikiInfo>, (StatusCode, Json<ErrBody>)> {
    let (project, path) = {
        let cfg = state.config.read().await;
        (cfg.wiki_project_id.clone(), state.paths.wiki_dir().to_string())
    };
    let pages = state
        .meta
        .list_all_wiki_pages()
        .map_err(|e| err_response(e.to_string()))?
        .into_iter()
        .filter(|p| {
            // Drop any stale meta whose file vanished between watcher ticks.
            resolve_wiki_abs(&state.paths, &p.path).is_ok()
        })
        .map(|p| {
            let project_id = p.project_id.clone();
            page_to_card(&state.paths, &project_id, p)
        })
        .collect();
    Ok(Json(WikiInfo {
        path,
        project_id: project,
        revision: state.wiki_revision.load(Ordering::SeqCst),
        pages,
    }))
}

async fn wiki_page(
    State(state): State<ApiState>,
    Query(q): Query<WikiPageQuery>,
) -> Result<Json<WikiPageBody>, (StatusCode, Json<ErrBody>)> {
    let pages = state.meta.list_all_wiki_pages().map_err(|e| err_response(e.to_string()))?;
    let page = pages
        .into_iter()
        .find(|p| {
            q.id.as_deref().is_some_and(|id| id == p.id)
                || q.path.as_deref().is_some_and(|path| path == p.path)
        })
        .ok_or_else(|| {
            (StatusCode::NOT_FOUND, Json(ErrBody { error: "wiki page not found".into() }))
        })?;
    let abs = resolve_wiki_abs(&state.paths, &page.path)?;
    let content = std::fs::read_to_string(&abs).map_err(|e| err_response(e.to_string()))?;
    let relative_path = wiki_relative_path(&page.project_id, &page.path);
    Ok(Json(WikiPageBody {
        id: page.id,
        project_id: page.project_id,
        title: page.title,
        path: page.path,
        relative_path,
        updated_at: page.updated_at,
        content,
    }))
}

async fn wiki_archives(
    State(state): State<ApiState>,
    Query(q): Query<WikiArchiveQuery>,
) -> Result<Json<WikiArchiveList>, (StatusCode, Json<ErrBody>)> {
    let project = match q.project_id.clone() {
        Some(p) => p,
        None => state.config.read().await.wiki_project_id.clone(),
    };
    let slug = q.slug.trim().trim_start_matches('/').to_string();
    if slug.is_empty() || slug.contains("..") || slug.contains('/') {
        return Err(err_response("invalid archive slug".into()));
    }
    let dir = state.paths.wiki_dir().join(&project).join("archive").join(&slug);
    let mut files = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir.as_std_path()) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if std::path::Path::new(&name)
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
            {
                files.push(name);
            }
        }
    }
    files.sort();
    files.reverse();
    Ok(Json(WikiArchiveList { project_id: project, slug, files }))
}

async fn wiki_archive_file(
    State(state): State<ApiState>,
    Query(q): Query<WikiArchiveQuery>,
) -> Result<Json<WikiArchiveBody>, (StatusCode, Json<ErrBody>)> {
    let Some(file) = q.file.as_deref().map(str::trim).filter(|s| !s.is_empty()) else {
        return Err(err_response("archive file required".into()));
    };
    if file.contains("..")
        || file.contains('/')
        || !std::path::Path::new(file).extension().is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
    {
        return Err(err_response("invalid archive file".into()));
    }
    let project = match q.project_id.clone() {
        Some(p) => p,
        None => state.config.read().await.wiki_project_id.clone(),
    };
    let slug = q.slug.trim().to_string();
    if slug.is_empty() || slug.contains("..") || slug.contains('/') {
        return Err(err_response("invalid archive slug".into()));
    }
    let abs = state.paths.wiki_dir().join(&project).join("archive").join(&slug).join(file);
    let content =
        std::fs::read_to_string(abs.as_std_path()).map_err(|e| err_response(e.to_string()))?;
    Ok(Json(WikiArchiveBody { project_id: project, slug, file: file.to_string(), content }))
}

async fn workers_tick(
    State(state): State<ApiState>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrBody>)> {
    let Some(workers) = state.workers.clone() else {
        return Err(err_response("workers unavailable".into()));
    };
    workers.tick_once().await.map_err(|e| err_response(e.to_string()))?;
    let wiki_project_id = state.config.read().await.wiki_project_id.clone();
    let queue = state.jobs.queue_stats().await.unwrap_or(QueueStats {
        pending: 0,
        running: 0,
        done: 0,
        failed: 0,
        dead: 0,
    });
    Ok(Json(serde_json::json!({
        "ok": true,
        "embeddings": state.ch.embedding_count(LEXICAL_SPACE).await.unwrap_or(0),
        "wiki_pages": state.meta.wiki_page_count(&wiki_project_id).unwrap_or(0),
        "topics": state.meta.list_topics().map_or(0, |t| t.len()),
        "summaries": state.meta.list_summaries().map_or(0, |s| s.len()),
        "queue": queue,
        "role": WorkerRole::from_env().as_str(),
    })))
}

async fn workers_queue(
    State(state): State<ApiState>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrBody>)> {
    let queue = state.jobs.queue_stats().await.map_err(|e| err_response(e.to_string()))?;
    Ok(Json(serde_json::json!({
        "role": WorkerRole::from_env().as_str(),
        "queue": queue,
        "tasks": {
            "embed": WorkerRole::Embed.tasks(),
            "compact": WorkerRole::Compact.tasks(),
            "wiki": WorkerRole::Wiki.tasks(),
        },
    })))
}

#[derive(Debug, Deserialize)]
struct TopicQuery {
    q: Option<String>,
    slug: Option<String>,
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct TopicCurateRequest {
    slug: String,
    title: Option<String>,
    summary: Option<String>,
    aliases: Option<Vec<String>>,
    tags: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct EventIdQuery {
    id: String,
}

async fn topics_list(
    State(state): State<ApiState>,
    Query(q): Query<TopicQuery>,
) -> Result<Json<Vec<TopicMeta>>, (StatusCode, Json<ErrBody>)> {
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let query = q.q.unwrap_or_default();
    state.meta.search_topics(&query, limit).map(Json).map_err(|e| err_response(e.to_string()))
}

async fn topic_get(
    State(state): State<ApiState>,
    Query(q): Query<TopicQuery>,
) -> Result<Json<TopicMeta>, (StatusCode, Json<ErrBody>)> {
    let slug = q.slug.or(q.q).unwrap_or_default();
    state
        .meta
        .get_topic(&slug)
        .map_err(|e| err_response(e.to_string()))?
        .map(Json)
        .ok_or_else(|| (StatusCode::NOT_FOUND, Json(ErrBody { error: "topic not found".into() })))
}

async fn topic_curate(
    State(state): State<ApiState>,
    Json(body): Json<TopicCurateRequest>,
) -> Result<Json<TopicMeta>, (StatusCode, Json<ErrBody>)> {
    state
        .meta
        .mark_topic_curated(&body.slug, body.title, body.summary, body.aliases, body.tags)
        .map_err(|e| err_response(e.to_string()))?
        .map(Json)
        .ok_or_else(|| (StatusCode::NOT_FOUND, Json(ErrBody { error: "topic not found".into() })))
}

async fn summaries_list(
    State(state): State<ApiState>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrBody>)> {
    let rows = state.meta.list_summaries().map_err(|e| err_response(e.to_string()))?;
    Ok(Json(serde_json::json!({ "summaries": rows })))
}

#[derive(Debug, Deserialize)]
struct TidyQuery {
    pending: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct TidyDecideRequest {
    id: String,
    /// `approved` | `rejected`
    status: String,
}

async fn tidy_list(
    State(state): State<ApiState>,
    Query(q): Query<TidyQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrBody>)> {
    let pending_only = q.pending.unwrap_or(true);
    let proposals =
        state.meta.list_tidy_proposals(pending_only).map_err(|e| err_response(e.to_string()))?;
    Ok(Json(serde_json::json!({ "proposals": proposals })))
}

async fn tidy_decide(
    State(state): State<ApiState>,
    Json(body): Json<TidyDecideRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrBody>)> {
    let status = body.status.trim();
    if !matches!(status, "approved" | "rejected") {
        return Err(err_response("status must be approved or rejected".into()));
    }
    let row = if status == "approved" {
        state.meta.apply_tidy_proposal(&body.id).map_err(|e| err_response(e.to_string()))?
    } else {
        state.meta.set_tidy_status(&body.id, status).map_err(|e| err_response(e.to_string()))?
    };
    let Some(row) = row else {
        return Err((StatusCode::NOT_FOUND, Json(ErrBody { error: "proposal not found".into() })));
    };
    Ok(Json(serde_json::json!({ "proposal": row })))
}

#[derive(Debug, Deserialize)]
struct TagDecideRequest {
    id: String,
    /// `accepted` | `rejected`
    status: String,
}

async fn tags_list(
    State(state): State<ApiState>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrBody>)> {
    let suggestions =
        state.meta.list_tag_suggestions(true).map_err(|e| err_response(e.to_string()))?;
    Ok(Json(serde_json::json!({ "suggestions": suggestions })))
}

async fn tags_decide(
    State(state): State<ApiState>,
    Json(body): Json<TagDecideRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrBody>)> {
    let status = body.status.trim();
    if !matches!(status, "accepted" | "rejected") {
        return Err(err_response("status must be accepted or rejected".into()));
    }
    let Some(row) =
        state.meta.set_tag_status(&body.id, status).map_err(|e| err_response(e.to_string()))?
    else {
        return Err((StatusCode::NOT_FOUND, Json(ErrBody { error: "tag not found".into() })));
    };
    if status == "accepted" {
        // Attach tag to any topic that already lists this session.
        if let Ok(topics) = state.meta.list_topics() {
            for mut topic in topics {
                if topic.session_ids.iter().any(|s| s == &row.session_id)
                    && !topic.tags.iter().any(|t| t == &row.tag)
                {
                    topic.tags.push(row.tag.clone());
                    topic.updated_at = Utc::now().to_rfc3339();
                    let _ = state.meta.upsert_topic(&topic);
                }
            }
        }
    }
    Ok(Json(serde_json::json!({ "suggestion": row })))
}

#[derive(Debug, Deserialize)]
struct FlaggedRetryRequest {
    task: String,
    job_key: String,
}

async fn workers_flagged(
    State(state): State<ApiState>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrBody>)> {
    let jobs = state
        .jobs
        .list_jobs_by_status(JobStatus::Dead, 50)
        .await
        .map_err(|e| err_response(e.to_string()))?;
    Ok(Json(serde_json::json!({ "flagged": jobs })))
}

async fn workers_flagged_retry(
    State(state): State<ApiState>,
    Json(body): Json<FlaggedRetryRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrBody>)> {
    let dead = state
        .jobs
        .list_jobs_by_status(JobStatus::Dead, 200)
        .await
        .map_err(|e| err_response(e.to_string()))?;
    let Some(mut job) = dead.into_iter().find(|j| j.task == body.task && j.job_key == body.job_key)
    else {
        return Err((StatusCode::NOT_FOUND, Json(ErrBody { error: "job not found".into() })));
    };
    job.status = JobStatus::Pending;
    job.attempts = 0;
    job.last_error = None;
    job.worker_id = None;
    job.lease_until = None;
    job.run_at = Utc::now();
    job.updated_at = Utc::now();
    state.jobs.enqueue_job(&job).await.map_err(|e| err_response(e.to_string()))?;
    Ok(Json(serde_json::json!({ "ok": true, "job": job })))
}

#[derive(Debug, Deserialize)]
struct StartupQuery {
    topic: Option<String>,
    q: Option<String>,
    limit: Option<u32>,
    /// Project root — when set, load SOUL.md / IDENTITY.md / MEMORY.md.
    cwd: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct StartupWorkspaceBody {
    #[serde(default)]
    soul: Option<String>,
    #[serde(default)]
    identity: Option<String>,
    #[serde(default)]
    memory: Option<String>,
    #[serde(default)]
    agents: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct StartupPostBody {
    #[serde(default)]
    topic: Option<String>,
    #[serde(default)]
    q: Option<String>,
    #[serde(default)]
    limit: Option<u32>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    workspace: Option<StartupWorkspaceBody>,
}

async fn memory_startup(
    State(state): State<ApiState>,
    Query(q): Query<StartupQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrBody>)> {
    build_memory_startup(
        &state,
        q.topic.as_deref(),
        q.q.as_deref(),
        q.limit,
        q.cwd.as_deref(),
        None,
    )
    .await
}

async fn memory_startup_post(
    State(state): State<ApiState>,
    Query(q): Query<StartupQuery>,
    body: Option<Json<StartupPostBody>>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrBody>)> {
    let body = body.map(|Json(b)| b).unwrap_or_default();
    let topic = body.topic.or(q.topic);
    let query = body.q.or(q.q);
    let limit = body.limit.or(q.limit);
    let cwd = body.cwd.or(q.cwd);
    build_memory_startup(
        &state,
        topic.as_deref(),
        query.as_deref(),
        limit,
        cwd.as_deref(),
        body.workspace.as_ref(),
    )
    .await
}

async fn build_memory_startup(
    state: &ApiState,
    topic_slug: Option<&str>,
    query: Option<&str>,
    limit: Option<u32>,
    cwd: Option<&str>,
    workspace_body: Option<&StartupWorkspaceBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrBody>)> {
    let topic = topic_slug
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .and_then(|slug| state.meta.get_topic(slug).ok().flatten());
    let topic_title = topic.as_ref().map(|t| t.title.clone());
    let topic_page = topic.as_ref().and_then(|t| {
        t.startup_context.clone().or_else(|| t.summary.clone()).or_else(|| {
            (!t.decisions.is_empty()).then(|| {
                t.decisions.iter().map(|d| format!("- {d}")).collect::<Vec<_>>().join("\n")
            })
        })
    });
    let mut workspace = Vec::new();
    if let Some(cwd) = cwd.map(str::trim).filter(|s| !s.is_empty()) {
        workspace.extend(load_workspace_memory(std::path::Path::new(cwd)));
    }
    if let Some(ws) = workspace_body {
        for (title, value) in [
            ("Soul", ws.soul.as_deref()),
            ("Identity", ws.identity.as_deref()),
            ("Memory", ws.memory.as_deref()),
            ("Agents", ws.agents.as_deref()),
        ] {
            let Some(body) = value.map(str::trim).filter(|s| !s.is_empty()) else {
                continue;
            };
            if workspace.iter().any(|s| s.title == title) {
                continue;
            }
            workspace
                .push(WorkspaceMemorySection { title: title.to_string(), body: body.to_string() });
        }
    }
    let recent = state.store.recent(40).await.unwrap_or_default();
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
    if let Some(query) = query.map(str::trim).filter(|s| !s.is_empty()) {
        let limit = limit.unwrap_or(8).min(20);
        if state.config.read().await.capabilities.vector_search {
            if let Ok((_, convs)) = hybrid_conversation_search(state, query, limit).await {
                for c in convs {
                    let preview = c.preview.as_deref().unwrap_or(c.title.as_str());
                    hit_lines.push(format!(
                        "{} · {}",
                        c.id,
                        preview.chars().take(120).collect::<String>()
                    ));
                }
            }
        } else if let Ok(events) = state.store.search_keyword(query, limit).await {
            for e in events {
                hit_lines
                    .push(e.content.as_deref().unwrap_or("").chars().take(120).collect::<String>());
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
    Ok(Json(serde_json::json!({
        "markdown": markdown,
        "topic": topic,
        "workspace_sections": workspace.iter().map(|s| s.title.clone()).collect::<Vec<_>>(),
    })))
}

async fn traffic_get_full(
    State(state): State<ApiState>,
    Query(q): Query<EventIdQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrBody>)> {
    let id = q.id.trim();
    if id.is_empty() {
        return Err(err_response("id required".into()));
    }
    let mut events =
        state.store.get_by_ids(&[id.to_string()]).await.map_err(|e| err_response(e.to_string()))?;
    let Some(mut event) = events.pop() else {
        return Err((StatusCode::NOT_FOUND, Json(ErrBody { error: "event not found".into() })));
    };
    hydrate_event_content(&state.paths, &mut event);
    let turns = normalize_event_turns(&event);
    Ok(Json(serde_json::json!({
        "event": event,
        "turns": turns,
        "hydrated": event.body_ref.is_some(),
    })))
}

async fn conversation_browse(
    State(state): State<ApiState>,
    Query(q): Query<ConversationQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrBody>)> {
    let id = q.id.unwrap_or_default();
    if id.trim().is_empty() {
        return Err(err_response("id required".into()));
    }
    let limit = q.limit.unwrap_or(200).min(2000);
    let mut events = state
        .store
        .conversation_events(&id, limit)
        .await
        .map_err(|e| err_response(e.to_string()))?;
    rivet_core::hydrate_events(&state.paths, &mut events);
    let enrichments = state.meta.list_enrichments(&id, 200).unwrap_or_default();
    let summary = state.meta.get_summary_for_session(&id).ok().flatten();
    let turns: Vec<_> = events.iter().flat_map(normalize_event_turns).collect();
    Ok(Json(serde_json::json!({
        "id": id,
        "events": events,
        "turns": turns,
        "enrichments": enrichments,
        "summary": summary,
    })))
}

async fn memory_stats(
    State(state): State<ApiState>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrBody>)> {
    let usage = state.store.usage_totals().await.map_err(|e| err_response(e.to_string()))?;
    let recent = state.store.recent(200).await.unwrap_or_default();
    let soft = recent
        .iter()
        .filter(|e| {
            e.capture_quality == Some(rivet_core::CaptureQuality::Soft)
                || e.session_id.as_deref().is_some_and(|s| s.starts_with("soft:"))
        })
        .count();
    let wire = recent.len().saturating_sub(soft);
    let topics = state.meta.list_topics().map_or(0, |t| t.len());
    let summaries = state.meta.list_summaries().map_or(0, |s| s.len());
    let embeddings = state.ch.embedding_count(LEXICAL_SPACE).await.unwrap_or(0);
    Ok(Json(serde_json::json!({
        "events": usage.events,
        "tokens_in": usage.tokens_in,
        "tokens_out": usage.tokens_out,
        "recent_wire": wire,
        "recent_soft": soft,
        "topics": topics,
        "summaries": summaries,
        "embeddings": embeddings,
        "cursors": {
            "vectorize": state.meta.job_cursor("vectorize").ok().flatten(),
            "wiki": state.meta.job_cursor("wiki").ok().flatten(),
            "topics": state.meta.job_cursor("topics").ok().flatten(),
            "classify": state.meta.job_cursor("classify").ok().flatten(),
            "compact": state.meta.job_cursor("compact").ok().flatten(),
        }
    })))
}

#[derive(Debug, Deserialize)]
struct LogQuery {
    lines: Option<usize>,
}

#[derive(Serialize)]
struct LogTail {
    kind: String,
    path: String,
    text: String,
}

async fn tail_logs(
    State(state): State<ApiState>,
    Path(kind): Path<String>,
    Query(q): Query<LogQuery>,
) -> Result<Json<LogTail>, (StatusCode, Json<ErrBody>)> {
    let lines = q.lines.unwrap_or(120).clamp(20, 500);
    let path = match kind.as_str() {
        "proxy" => newest_log_file(state.paths.proxy_logs_dir().as_std_path(), "main.log"),
        "clickhouse" => {
            let dir = state.paths.clickhouse_log_dir();
            let preferred = dir.join("clickhouse.log");
            if preferred.exists() {
                preferred.as_std_path().to_path_buf()
            } else {
                newest_log_file(dir.as_std_path(), "clickhouse.err.log")
            }
        },
        other => {
            return Err(err_response(format!(
                "unknown log kind '{other}' (use proxy or clickhouse)"
            )));
        },
    };
    let text = tail_file(&path, lines).unwrap_or_else(|e| format!("(could not read log: {e})"));
    Ok(Json(LogTail { kind, path: path.display().to_string(), text }))
}

fn newest_log_file(dir: &std::path::Path, fallback_name: &str) -> PathBuf {
    let fallback = dir.join(fallback_name);
    let Ok(entries) = std::fs::read_dir(dir) else {
        return fallback;
    };
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("log") {
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        match &best {
            None => best = Some((modified, path)),
            Some((t, _)) if modified > *t => best = Some((modified, path)),
            _ => {},
        }
    }
    best.map(|(_, p)| p).unwrap_or(fallback)
}

fn tail_file(path: &std::path::Path, max_lines: usize) -> std::io::Result<String> {
    if !path.exists() {
        return Ok(format!("(no log yet at {})", path.display()));
    }
    let raw = std::fs::read_to_string(path)?;
    let collected: Vec<&str> = raw.lines().rev().take(max_lines).collect();
    let mut out = String::new();
    for line in collected.into_iter().rev() {
        out.push_str(line);
        out.push('\n');
    }
    Ok(out)
}

const fn err_response(msg: String) -> (StatusCode, Json<ErrBody>) {
    (StatusCode::BAD_REQUEST, Json(ErrBody { error: msg }))
}

pub async fn serve(addr: std::net::SocketAddr, state: ApiState) -> Result<()> {
    let app = router(state);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, "rivet api listening");
    axum::serve(listener, app).await?;
    Ok(())
}
