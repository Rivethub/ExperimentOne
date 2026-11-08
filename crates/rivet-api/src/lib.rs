//! Control plane HTTP API used by the desktop UI.

mod quota;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    routing::{delete, get, post},
    Json, Router,
};
use chrono::{Duration, Utc};
use rivet_core::{
    claude_mcp_json, claude_settings_json, codex_config_toml, localhost_port_free,
    provider_catalog, Capabilities, ProviderKind, RivetConfig, RivetPaths, TrafficEvent,
    TrafficRole, UsageTotals,
};
use rivet_store::{MetaStore, TrafficStore, WikiPageMeta};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;
use tower_http::cors::CorsLayer;

/// Process / sidecar control implemented by `rivet-runtime`.
pub trait ControlApi: Send + Sync {
    fn proxy_running(&self) -> bool;
    fn proxy_start(&self) -> Result<(), String>;
    fn proxy_stop(&self) -> Result<(), String>;
    fn login_start(&self, provider: &str) -> Result<LoginStartResponse, String>;
    fn login_status(&self) -> LoginStatusResponse;
    fn login_cancel(&self) -> Result<(), String>;
    fn list_accounts(&self) -> Result<Vec<AccountInfo>, String>;
    fn remove_account(&self, id: &str) -> Result<(), String>;
    fn write_harness(&self, target: &str) -> Result<HarnessWriteResponse, String>;
    fn import_vertex(&self, path: &str) -> Result<LoginStartResponse, String>;
}

#[derive(Clone)]
pub struct ApiState {
    pub config: Arc<RwLock<RivetConfig>>,
    pub store: Arc<dyn TrafficStore>,
    pub control: Arc<dyn ControlApi>,
    pub paths: RivetPaths,
    pub meta: Arc<MetaStore>,
    /// `sqlite` or `sqlite+clickhouse` when dual-write is armed.
    pub traffic_backend: &'static str,
    /// Background vectorize + wiki workers.
    pub workers: Option<Arc<rivet_worker::WorkerPool>>,
}

#[derive(Serialize)]
pub struct StatusResponse {
    pub ok: bool,
    pub proxy_running: bool,
    pub proxy_base_url: String,
    pub mcp_url: String,
    pub access_key_hint: String,
    pub capabilities: Capabilities,
    pub usage: UsageTotals,
    pub account_count: u64,
    pub traffic_backend: &'static str,
    pub wiki_dir: String,
    pub embedding_model: Option<String>,
    pub wiki_model: Option<String>,
    /// Soft warnings for the desktop UI (port conflicts, onboarding hints).
    pub warnings: Vec<String>,
    pub onboarding: OnboardingStatus,
    pub workers: WorkersStatus,
}

#[derive(Serialize)]
pub struct WorkersStatus {
    pub vector_search: bool,
    pub wiki: bool,
    pub embeddings: u64,
    pub wiki_pages: u64,
    pub vectorize_cursor: Option<String>,
    pub wiki_cursor: Option<String>,
}

#[derive(Serialize)]
pub struct OnboardingStatus {
    pub proxy_running: bool,
    pub has_accounts: bool,
    pub has_traffic: bool,
    pub harness_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
}

#[derive(Debug, Clone, Serialize)]
pub struct HarnessWriteResponse {
    pub target: String,
    pub path: String,
    pub env_hint: String,
    pub note: String,
}

#[derive(Debug, Deserialize)]
pub struct ImportRequest {
    pub path: String,
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

#[derive(Debug, Deserialize)]
pub struct CapabilitiesPatch {
    pub vector_search: Option<bool>,
    pub wiki: Option<bool>,
    pub teams: Option<bool>,
}

#[derive(Serialize)]
struct ErrBody {
    error: String,
}

pub fn router(state: ApiState) -> Router {
    Router::new()
        .route("/v1/status", get(status))
        .route("/v1/config", get(get_config).put(put_config))
        .route("/v1/traffic/recent", get(recent))
        .route("/v1/traffic/search", get(search_traffic))
        .route("/v1/demo/seed", post(demo_seed))
        .route("/v1/harness/claude.env", get(claude_env))
        .route("/v1/harness/codex.toml", get(codex_toml))
        .route("/v1/harness/mcp.json", get(mcp_json))
        .route("/v1/harness/write", post(harness_write))
        .route("/v1/proxy/start", post(proxy_start))
        .route("/v1/proxy/stop", post(proxy_stop))
        .route("/v1/providers", get(list_providers))
        .route("/v1/accounts", get(accounts))
        .route("/v1/accounts/{id}", delete(account_delete))
        .route("/v1/accounts/login", post(login_start))
        .route("/v1/accounts/login/status", get(login_status))
        .route("/v1/accounts/login/cancel", post(login_cancel))
        .route("/v1/accounts/import/vertex", post(import_vertex))
        .route("/v1/quota", get(quota_snapshot))
        .route("/v1/quota/refresh", post(quota_refresh))
        .route("/v1/export", post(export_bag))
        .route("/v1/import", post(import_bag))
        .route("/v1/wiki", get(wiki_info))
        .route("/v1/workers/tick", post(workers_tick))
        .route("/v1/logs/{kind}", get(tail_logs))
        .layer(CorsLayer::permissive())
        .with_state(state)
}

async fn status(State(state): State<ApiState>) -> Json<StatusResponse> {
    let usage = state.store.usage_totals().await.unwrap_or_default();
    let proxy_running = state.control.proxy_running();
    let cfg = state.config.read().await;
    let key = &cfg.proxy_access_key;
    let hint = if key.len() > 12 {
        format!("{}…{}", &key[..8], &key[key.len() - 4..])
    } else {
        "***".into()
    };
    let account_count = state
        .control
        .list_accounts()
        .map(|a| a.len() as u64)
        .unwrap_or(0);
    let mut warnings = Vec::new();
    if !proxy_running && !localhost_port_free(cfg.proxy_port) {
        warnings.push(format!(
            "Proxy port {} is already in use by another process — stop it or change proxy_port in config.json",
            cfg.proxy_port
        ));
    }
    let harness_ready = state.paths.harness_claude_dir().join("settings.json").exists()
        || state.paths.harness_codex_dir().join("config.toml").exists();
    Json(StatusResponse {
        ok: true,
        proxy_running,
        proxy_base_url: cfg.proxy_base_url(),
        mcp_url: cfg.mcp_url(),
        access_key_hint: hint,
        capabilities: cfg.capabilities.clone(),
        usage: usage.clone(),
        account_count,
        traffic_backend: state.traffic_backend,
        wiki_dir: state.paths.wiki_dir().to_string(),
        embedding_model: cfg.embedding_model.clone(),
        wiki_model: cfg.wiki_model.clone(),
        warnings,
        onboarding: OnboardingStatus {
            proxy_running,
            has_accounts: account_count > 0,
            has_traffic: usage.events > 0,
            harness_ready,
        },
        workers: WorkersStatus {
            vector_search: cfg.capabilities.vector_search,
            wiki: cfg.capabilities.wiki,
            embeddings: state.meta.embedding_count().unwrap_or(0),
            wiki_pages: state
                .meta
                .wiki_page_count(&cfg.wiki_project_id)
                .unwrap_or(0),
            vectorize_cursor: state.meta.job_cursor("vectorize").ok().flatten(),
            wiki_cursor: state.meta.job_cursor("wiki").ok().flatten(),
        },
    })
}

async fn get_config(State(state): State<ApiState>) -> Json<RivetConfig> {
    Json(state.config.read().await.clone())
}

async fn put_config(
    State(state): State<ApiState>,
    Json(body): Json<ConfigUpdate>,
) -> Result<Json<RivetConfig>, (StatusCode, Json<ErrBody>)> {
    let mut cfg = state.config.write().await;
    if let Some(m) = body.embedding_model {
        cfg.embedding_model = if m.trim().is_empty() {
            None
        } else {
            Some(m)
        };
    }
    if let Some(m) = body.wiki_model {
        cfg.wiki_model = if m.trim().is_empty() { None } else { Some(m) };
    }
    if let Some(p) = body.wiki_project_id {
        if !p.trim().is_empty() {
            cfg.wiki_project_id = p;
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
    cfg.save(&state.paths)
        .map_err(|e| err_response(e.to_string()))?;
    Ok(Json(cfg.clone()))
}

#[derive(Debug, Deserialize)]
struct TrafficQuery {
    limit: Option<u32>,
    q: Option<String>,
}

async fn recent(
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
    state
        .store
        .recent(limit)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
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
    let usage = state
        .store
        .usage_totals()
        .await
        .map_err(|e| err_response(e.to_string()))?;
    if usage.events > 0 && !body.force.unwrap_or(false) {
        return Ok(Json(DemoSeedResponse {
            inserted: 0,
            note: "store already has traffic — pass {\"force\":true} to append demo events".into(),
        }));
    }

    let events = build_demo_events();
    let n = events.len() as u64;
    state
        .store
        .insert_batch(&events)
        .await
        .map_err(|e| err_response(e.to_string()))?;
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
        let mins_ago = (i as i64 + 1) * 7;
        let mut ev = TrafficEvent::new(provider);
        ev.ts = now - Duration::minutes(mins_ago);
        ev.model = Some(model.into());
        ev.role = role;
        ev.content = Some(content.into());
        ev.tokens_in = tin + ((i as u32 % 5) * 17);
        ev.tokens_out = tout + ((i as u32 % 7) * 23);
        ev.latency_ms = Some(400 + (i as u64 % 12) * 85);
        ev.status_code = Some(if i % 11 == 0 { 429 } else { 200 });
        ev.account_label = Some(if matches!(provider, ProviderKind::Claude) {
            "claude-primary".into()
        } else {
            "codex-work".into()
        });
        ev.session_id = Some(format!("demo-session-{}", i / 4));
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
                    .map(|p| format!("{p:.0}% left"))
                    .unwrap_or_else(|| "— pending live".into());
                acct.reset_hint = q
                    .reset_at
                    .clone()
                    .map(|r| format_account_reset(&r))
                    .or_else(|| {
                        q.cooldown_seconds
                            .map(|s| format!("cooldown {s}s"))
                    })
                    .unwrap_or_else(|| "—".into());
            }
        }
    }
    Ok(Json(accounts))
}

async fn quota_snapshot(
    State(state): State<ApiState>,
) -> Result<Json<quota::QuotaSnapshot>, (StatusCode, Json<ErrBody>)> {
    build_quota_snapshot(&state)
        .await
        .map(Json)
        .map_err(err_response)
}

async fn quota_refresh(
    State(state): State<ApiState>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrBody>)> {
    let cfg = state.config.read().await.clone();
    let refreshed = quota::refresh_credentials(&cfg)
        .await
        .map_err(|e| err_response(e.to_string()))?;
    let snap = build_quota_snapshot(&state)
        .await
        .map_err(err_response)?;
    Ok(Json(serde_json::json!({
        "ok": true,
        "refresh": refreshed,
        "quota": snap,
    })))
}

async fn build_quota_snapshot(state: &ApiState) -> Result<quota::QuotaSnapshot, String> {
    let cfg = state.config.read().await.clone();
    let burn = burn_by_provider(state).await;
    match quota::fetch_quota_snapshot(&cfg, &burn).await {
        Ok(snap) => Ok(snap),
        Err(err) => {
            tracing::debug!(error = %err, "quota management fetch failed; using local fallback");
            let local = state
                .control
                .list_accounts()
                .unwrap_or_default()
                .into_iter()
                .map(|a| (a.id, a.provider, a.label))
                .collect::<Vec<_>>();
            Ok(quota::local_fallback_snapshot(&local, &burn))
        }
    }
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
        *out.entry(provider).or_default() += (ev.tokens_in + ev.tokens_out) as f64;
    }
    let hours = ((Utc::now() - earliest).num_seconds().max(1) as f64 / 3600.0).max(0.25);
    for v in out.values_mut() {
        *v /= hours;
    }
    out
}

fn format_account_reset(reset_at: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(reset_at)
        .ok()
        .map(|d| d.with_timezone(&Utc).format("%a %H:%M UTC").to_string())
        .unwrap_or_else(|| reset_at.to_string())
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
        .login_start(&body.provider)
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
    state
        .control
        .import_vertex(&body.path)
        .map(Json)
        .map_err(err_response)
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
    state
        .control
        .write_harness(&body.target)
        .map(Json)
        .map_err(err_response)
}

async fn export_bag(
    State(state): State<ApiState>,
) -> Result<Json<ExportResponse>, (StatusCode, Json<ErrBody>)> {
    let _ = state.paths.ensure().map_err(|e| err_response(e.to_string()))?;
    let name = format!("rivet-export-{}.rivetbag", Utc::now().format("%Y%m%d-%H%M%S"));
    let path = state.paths.exports_dir().join(&name);
    let manifest = rivet_export::export_bag(state.store.clone(), path.as_std_path())
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
        return Err(err_response(format!(
            "file not found: {}",
            path.display()
        )));
    }
    if path.extension().and_then(|s| s.to_str()) != Some("rivetbag")
        && !path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .ends_with(".rivetbag")
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

#[derive(Serialize)]
struct WikiInfo {
    path: String,
    project_id: String,
    pages: Vec<WikiPageMeta>,
}

async fn wiki_info(
    State(state): State<ApiState>,
) -> Result<Json<WikiInfo>, (StatusCode, Json<ErrBody>)> {
    let cfg = state.config.read().await;
    let project = cfg.wiki_project_id.clone();
    let path = state.paths.wiki_dir().join(&project).to_string();
    let pages = state
        .meta
        .list_wiki_pages(&project)
        .map_err(|e| err_response(e.to_string()))?;
    Ok(Json(WikiInfo {
        path,
        project_id: project,
        pages,
    }))
}

async fn workers_tick(
    State(state): State<ApiState>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrBody>)> {
    let Some(workers) = state.workers.clone() else {
        return Err(err_response("workers unavailable".into()));
    };
    workers
        .tick_once()
        .await
        .map_err(|e| err_response(e.to_string()))?;
    let cfg = state.config.read().await;
    Ok(Json(serde_json::json!({
        "ok": true,
        "embeddings": state.meta.embedding_count().unwrap_or(0),
        "wiki_pages": state.meta.wiki_page_count(&cfg.wiki_project_id).unwrap_or(0),
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
        }
        other => {
            return Err(err_response(format!(
                "unknown log kind '{other}' (use proxy or clickhouse)"
            )));
        }
    };
    let text = tail_file(&path, lines).unwrap_or_else(|e| format!("(could not read log: {e})"));
    Ok(Json(LogTail {
        kind,
        path: path.display().to_string(),
        text,
    }))
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
            _ => {}
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

fn err_response(msg: String) -> (StatusCode, Json<ErrBody>) {
    (StatusCode::BAD_REQUEST, Json(ErrBody { error: msg }))
}

pub async fn serve(addr: std::net::SocketAddr, state: ApiState) -> Result<()> {
    let app = router(state);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, "rivet api listening");
    axum::serve(listener, app).await?;
    Ok(())
}
