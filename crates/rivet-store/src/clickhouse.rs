//! `ClickHouse` traffic store — sole persistence for captured events + embeddings.
//!
//! Query strings use `ClickHouse` `{name:Type}` bind params (not Rust `format!`).

#![allow(clippy::literal_string_with_formatting_args)]

use std::collections::HashSet;

use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use clickhouse::{Client, Row};
use rivet_core::{
    CaptureQuality, ProviderKind, TrafficEvent, TrafficRole, UsageTotals, LEXICAL_EMBED_DIMS,
    LEXICAL_SPACE,
};
use serde::{Deserialize, Serialize};
use tracing::{info, warn};
use uuid::Uuid;

use crate::TrafficStore;

/// Canonical traffic DDL (also embedded in [`crate::migrations`]).
pub const TRAFFIC_EVENTS_DDL: &str = crate::migrations::MIGRATIONS[0].sql;

/// Canonical embeddings DDL (also embedded in [`crate::migrations`]).
pub const EMBEDDINGS_DDL: &str = crate::migrations::MIGRATIONS[3].sql;

/// One ANN hit from [`ClickHouseTrafficStore::search_embeddings`].
#[derive(Debug, Clone, PartialEq)]
pub struct EmbeddingSearchHit {
    pub event_id: String,
    /// `cosineDistance` (0 = identical for unit vectors).
    pub distance: f32,
}

#[derive(Debug, Clone, Row, Serialize, Deserialize)]
struct TrafficEventRow {
    id: Uuid,
    #[serde(with = "clickhouse::serde::chrono::datetime64::millis")]
    ts: DateTime<Utc>,
    provider: String,
    account_label: Option<String>,
    model: Option<String>,
    session_id: Option<String>,
    project_id: Option<String>,
    cwd: Option<String>,
    request_id: Option<String>,
    role: String,
    content: Option<String>,
    tokens_in: u32,
    tokens_out: u32,
    latency_ms: Option<u64>,
    status_code: Option<u16>,
    body_ref: Option<String>,
    capture_quality: Option<String>,
    agent_id: Option<String>,
    parent_agent_id: Option<String>,
    parent_session_id: Option<String>,
    request_class: Option<String>,
    agent_type: Option<String>,
    cache_read_tokens: u32,
    cache_creation_tokens: u32,
    thinking_tokens: u32,
    git_branch: Option<String>,
    git_repo: Option<String>,
    task_id: Option<String>,
    turn_id: Option<String>,
    upstream_host: Option<String>,
    attempt_count: u32,
    stop_reason: Option<String>,
    tool_names: Option<String>,
    stream_complete: Option<u8>,
    request_path: Option<String>,
    api_format: Option<String>,
    error_type: Option<String>,
    error_message: Option<String>,
    auth_id: Option<String>,
    has_thinking: Option<u8>,
    media_count: u32,
    tool_call_count: u32,
}

impl TrafficEventRow {
    fn from_event(event: &TrafficEvent) -> Result<Self> {
        let role = serde_json::to_value(event.role)?.as_str().unwrap_or("unknown").to_string();
        Ok(Self {
            id: event.id,
            ts: event.ts,
            provider: event.provider.as_str().to_string(),
            account_label: event.account_label.clone(),
            model: event.model.clone(),
            session_id: event.session_id.clone(),
            project_id: event.project_id.clone(),
            cwd: event.cwd.clone(),
            request_id: event.request_id.clone(),
            role,
            content: event.content.clone(),
            tokens_in: event.tokens_in,
            tokens_out: event.tokens_out,
            latency_ms: event.latency_ms,
            status_code: event.status_code,
            body_ref: event.body_ref.clone(),
            capture_quality: event.capture_quality.map(CaptureQuality::as_str).map(str::to_string),
            agent_id: event.agent_id.clone(),
            parent_agent_id: event.parent_agent_id.clone(),
            parent_session_id: event.parent_session_id.clone(),
            request_class: event.request_class.clone(),
            agent_type: event.agent_type.clone(),
            cache_read_tokens: event.cache_read_tokens,
            cache_creation_tokens: event.cache_creation_tokens,
            thinking_tokens: event.thinking_tokens,
            git_branch: event.git_branch.clone(),
            git_repo: event.git_repo.clone(),
            task_id: event.task_id.clone(),
            turn_id: event.turn_id.clone(),
            upstream_host: event.upstream_host.clone(),
            attempt_count: event.attempt_count,
            stop_reason: event.stop_reason.clone(),
            tool_names: event.tool_names.clone(),
            stream_complete: event.stream_complete.map(u8::from),
            request_path: event.request_path.clone(),
            api_format: event.api_format.clone(),
            error_type: event.error_type.clone(),
            error_message: event.error_message.clone(),
            auth_id: event.auth_id.clone(),
            has_thinking: event.has_thinking.map(u8::from),
            media_count: event.media_count,
            tool_call_count: event.tool_call_count,
        })
    }

    fn into_event(self) -> TrafficEvent {
        let role = match self.role.as_str() {
            "system" => TrafficRole::System,
            "user" => TrafficRole::User,
            "assistant" => TrafficRole::Assistant,
            "tool" => TrafficRole::Tool,
            _ => TrafficRole::Unknown,
        };
        TrafficEvent {
            id: self.id,
            ts: self.ts,
            provider: ProviderKind::parse(&self.provider),
            account_label: self.account_label,
            model: self.model,
            session_id: self.session_id,
            project_id: self.project_id,
            cwd: self.cwd,
            request_id: self.request_id,
            role,
            content: self.content,
            tokens_in: self.tokens_in,
            tokens_out: self.tokens_out,
            latency_ms: self.latency_ms,
            status_code: self.status_code,
            body_ref: self.body_ref,
            capture_quality: self.capture_quality.as_deref().map(CaptureQuality::parse),
            soft_alias: None,
            agent_id: self.agent_id,
            parent_agent_id: self.parent_agent_id,
            parent_session_id: self.parent_session_id,
            request_class: self.request_class,
            agent_type: self.agent_type,
            cache_read_tokens: self.cache_read_tokens,
            cache_creation_tokens: self.cache_creation_tokens,
            thinking_tokens: self.thinking_tokens,
            git_branch: self.git_branch,
            git_repo: self.git_repo,
            task_id: self.task_id,
            turn_id: self.turn_id,
            upstream_host: self.upstream_host,
            attempt_count: self.attempt_count,
            stop_reason: self.stop_reason,
            tool_names: self.tool_names,
            stream_complete: self.stream_complete.map(|v| v != 0),
            request_path: self.request_path,
            api_format: self.api_format,
            error_type: self.error_type,
            error_message: self.error_message,
            auth_id: self.auth_id,
            has_thinking: self.has_thinking.map(|v| v != 0),
            media_count: self.media_count,
            tool_call_count: self.tool_call_count,
        }
    }
}

#[derive(Debug, Clone, Row, Serialize, Deserialize)]
struct EmbeddingRow {
    event_id: Uuid,
    space: String,
    dims: Vec<f32>,
    #[serde(with = "clickhouse::serde::chrono::datetime64::millis")]
    updated_at: DateTime<Utc>,
}

#[derive(Debug, Row, Deserialize)]
struct UsageTotalsRow {
    events: u64,
    tokens_in: u64,
    tokens_out: u64,
}

#[derive(Debug, Row, Deserialize)]
struct EmbeddingCountRow {
    n: u64,
}

#[derive(Debug, Row, Deserialize)]
struct EmbeddingIdRow {
    event_id: Uuid,
}

#[derive(Debug, Row, Deserialize)]
struct EmbeddingHitRow {
    event_id: Uuid,
    distance: f32,
}

/// Official `ClickHouse` HTTP client wrapper for Rivet traffic + embeddings.
#[derive(Clone)]
pub struct ClickHouseTrafficStore {
    client: Client,
    url: String,
}

impl std::fmt::Debug for ClickHouseTrafficStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClickHouseTrafficStore").field("url", &self.url).finish_non_exhaustive()
    }
}

impl ClickHouseTrafficStore {
    pub fn new(http_base: impl AsRef<str>) -> Result<Self> {
        let url = normalize_http_url(http_base.as_ref());
        let client = Client::default()
            .with_url(&url)
            .with_database("rivet")
            .with_product_info("rivet", env!("CARGO_PKG_VERSION"));
        Ok(Self { client, url })
    }

    pub fn from_env() -> Option<Self> {
        Self::from_env_url().and_then(|url| match Self::new(&url) {
            Ok(s) => Some(s),
            Err(err) => {
                warn!(?err, "invalid RIVET_CLICKHOUSE_URL");
                None
            },
        })
    }

    /// Raw URL from env, if set.
    pub fn from_env_url() -> Option<String> {
        let url = std::env::var("RIVET_CLICKHOUSE_URL").ok()?;
        let url = url.trim().to_string();
        if url.is_empty() {
            None
        } else {
            Some(url)
        }
    }

    pub async fn ensure_schema(&self) -> Result<()> {
        Client::default()
            .with_url(&self.url)
            .query("CREATE DATABASE IF NOT EXISTS rivet")
            .execute()
            .await
            .context("create rivet database")?;
        let ran = crate::migrations::run(&self.client).await?;
        if ran > 0 {
            info!(ran, "clickhouse migrations applied");
        }
        Ok(())
    }

    /// Insert or replace one embedding (`ReplacingMergeTree` on `updated_at`).
    pub async fn upsert_embedding(&self, space: &str, event_id: &str, dims: &[f32]) -> Result<()> {
        self.upsert_embeddings_batch(space, &[(event_id.to_string(), dims.to_vec())]).await?;
        Ok(())
    }

    /// Bulk upsert embeddings. Rows with the wrong length for `lexical` are skipped.
    pub async fn upsert_embeddings_batch(
        &self,
        space: &str,
        rows: &[(String, Vec<f32>)],
    ) -> Result<u64> {
        if rows.is_empty() {
            return Ok(0);
        }
        let expect_dims = if space == LEXICAL_SPACE { Some(LEXICAL_EMBED_DIMS) } else { None };
        let now = Utc::now();
        let mut insert = self.client.insert::<EmbeddingRow>("embeddings").await?;
        let mut n = 0u64;
        for (event_id, dims) in rows {
            if expect_dims.is_some_and(|d| dims.len() != d) {
                warn!(
                    %event_id,
                    got = dims.len(),
                    want = LEXICAL_EMBED_DIMS,
                    "skip embedding with wrong dimensionality"
                );
                continue;
            }
            let Ok(event_uuid) = Uuid::parse_str(event_id) else {
                warn!(%event_id, "skip embedding with non-UUID event id");
                continue;
            };
            insert
                .write(&EmbeddingRow {
                    event_id: event_uuid,
                    space: space.to_string(),
                    dims: dims.clone(),
                    updated_at: now,
                })
                .await?;
            n += 1;
        }
        insert.end().await?;
        Ok(n)
    }

    /// Event ids that already have at least one row in `space` (duplicates ok).
    pub async fn embedded_event_ids(&self, space: &str) -> Result<HashSet<String>> {
        let rows = self
            .client
            .query("SELECT DISTINCT event_id FROM embeddings WHERE space = {space:String}")
            .param("space", space)
            .fetch_all::<EmbeddingIdRow>()
            .await?;
        Ok(rows.into_iter().map(|r| r.event_id.to_string()).collect())
    }

    pub async fn embedding_count(&self, space: &str) -> Result<u64> {
        let row = self
            .client
            .query("SELECT uniqExact(event_id) AS n FROM embeddings WHERE space = {space:String}")
            .param("space", space)
            .fetch_one::<EmbeddingCountRow>()
            .await
            .unwrap_or(EmbeddingCountRow { n: 0 });
        Ok(row.n)
    }

    /// Approximate nearest neighbors via `ClickHouse` HNSW (`cosineDistance` ASC).
    pub async fn search_embeddings(
        &self,
        space: &str,
        query_dims: &[f32],
        limit: u32,
    ) -> Result<Vec<EmbeddingSearchHit>> {
        let limit = limit.clamp(1, 5000);
        if space == LEXICAL_SPACE && query_dims.len() != LEXICAL_EMBED_DIMS {
            bail!("lexical query dims {} != expected {}", query_dims.len(), LEXICAL_EMBED_DIMS);
        }
        // Fetch a small overscan so ReplacingMergeTree duplicates can be collapsed.
        let fetch = limit.saturating_mul(4).max(limit);
        let rows = self
            .client
            .query(
                "SELECT event_id, cosineDistance(dims, {q:Array(Float32)}) AS distance \
                 FROM embeddings \
                 WHERE space = {space:String} AND length(dims) = {dim:UInt32} \
                 ORDER BY distance ASC LIMIT {fetch:UInt32}",
            )
            .param("q", query_dims)
            .param("space", space)
            .param("dim", u32::try_from(query_dims.len()).unwrap_or(u32::MAX))
            .param("fetch", fetch)
            .fetch_all::<EmbeddingHitRow>()
            .await?;

        let mut hits = Vec::new();
        let mut seen = HashSet::new();
        for row in rows {
            let id = row.event_id.to_string();
            if !seen.insert(id.clone()) {
                continue;
            }
            hits.push(EmbeddingSearchHit { event_id: id, distance: row.distance });
            if hits.len() >= limit as usize {
                break;
            }
        }
        Ok(hits)
    }

    /// One-shot import of legacy `meta/embeddings.json` rows into `ClickHouse`.
    pub async fn import_legacy_embeddings(&self, rows: &[(String, Vec<f32>)]) -> Result<u64> {
        if rows.is_empty() {
            return Ok(0);
        }
        let existing = self.embedding_count(LEXICAL_SPACE).await.unwrap_or(0);
        if existing > 0 {
            info!(existing, "skip legacy embeddings import — ClickHouse already has vectors");
            return Ok(0);
        }
        let n = self.upsert_embeddings_batch(LEXICAL_SPACE, rows).await?;
        if n > 0 {
            info!(n, "migrated legacy embeddings.json into ClickHouse");
        }
        Ok(n)
    }

    async fn fetch_events(&self, sql: &str) -> Result<Vec<TrafficEvent>> {
        let rows = self.client.query(sql).fetch_all::<TrafficEventRow>().await?;
        Ok(rows.into_iter().map(TrafficEventRow::into_event).collect())
    }

    async fn fetch_events_bound(
        &self,
        sql: &str,
        bind: impl FnOnce(clickhouse::query::Query) -> clickhouse::query::Query,
    ) -> Result<Vec<TrafficEvent>> {
        let query = bind(self.client.query(sql));
        let rows = query.fetch_all::<TrafficEventRow>().await?;
        Ok(rows.into_iter().map(TrafficEventRow::into_event).collect())
    }
}

fn normalize_http_url(raw: &str) -> String {
    let raw = raw.trim().trim_end_matches('/');
    if raw.starts_with("http://") || raw.starts_with("https://") {
        raw.to_string()
    } else {
        format!("http://{raw}")
    }
}

const EVENT_SELECT: &str = "SELECT id, ts, provider, account_label, model, session_id, project_id, cwd, request_id, role, content, tokens_in, tokens_out, latency_ms, status_code, body_ref, capture_quality, agent_id, parent_agent_id, parent_session_id, request_class, agent_type, cache_read_tokens, cache_creation_tokens, thinking_tokens, git_branch, git_repo, task_id, turn_id, upstream_host, attempt_count, stop_reason, tool_names, stream_complete, request_path, api_format, error_type, error_message, auth_id, has_thinking, media_count, tool_call_count FROM traffic_events";

#[async_trait]
impl TrafficStore for ClickHouseTrafficStore {
    async fn insert_event(&self, event: &TrafficEvent) -> Result<()> {
        self.insert_batch(std::slice::from_ref(event)).await
    }

    async fn insert_batch(&self, events: &[TrafficEvent]) -> Result<()> {
        if events.is_empty() {
            return Ok(());
        }
        let mut insert = self.client.insert::<TrafficEventRow>("traffic_events").await?;
        for event in events {
            insert.write(&TrafficEventRow::from_event(event)?).await?;
        }
        insert.end().await?;
        Ok(())
    }

    async fn recent(&self, limit: u32) -> Result<Vec<TrafficEvent>> {
        let limit = limit.clamp(1, 5000);
        self.fetch_events_bound(
            &format!("{EVENT_SELECT} ORDER BY ts DESC LIMIT {{limit:UInt32}}"),
            |q| q.param("limit", limit),
        )
        .await
    }

    async fn search_keyword(&self, query: &str, limit: u32) -> Result<Vec<TrafficEvent>> {
        let limit = limit.clamp(1, 5000);
        let q = query.trim();
        if q.is_empty() {
            return self.recent(limit).await;
        }
        self.fetch_events_bound(
            &format!(
                "{EVENT_SELECT} WHERE positionCaseInsensitive(ifNull(content, ''), {{q:String}}) > 0 \
                 OR positionCaseInsensitive(ifNull(model, ''), {{q:String}}) > 0 \
                 OR positionCaseInsensitive(ifNull(account_label, ''), {{q:String}}) > 0 \
                 OR positionCaseInsensitive(ifNull(session_id, ''), {{q:String}}) > 0 \
                 ORDER BY ts DESC LIMIT {{limit:UInt32}}"
            ),
            |qb| qb.param("q", q).param("limit", limit),
        )
        .await
    }

    async fn conversation_events(
        &self,
        conversation_id: &str,
        limit: u32,
    ) -> Result<Vec<TrafficEvent>> {
        let limit = limit.clamp(1, 5000);
        let id = conversation_id.trim();
        if id.is_empty() {
            return Ok(Vec::new());
        }
        if let Some(event_id) = id.strip_prefix("event:") {
            let eid = Uuid::parse_str(event_id).context("event conversation id")?;
            return self
                .fetch_events_bound(
                    &format!(
                        "{EVENT_SELECT} WHERE id = {{id:UUID}} ORDER BY ts ASC LIMIT {{limit:UInt32}}"
                    ),
                    |q| q.param("id", eid).param("limit", limit),
                )
                .await;
        }
        self.fetch_events_bound(
            &format!(
                "{EVENT_SELECT} WHERE session_id = {{sid:String}} ORDER BY ts ASC LIMIT {{limit:UInt32}}"
            ),
            |q| q.param("sid", id).param("limit", limit),
        )
        .await
    }

    async fn get_by_ids(&self, ids: &[String]) -> Result<Vec<TrafficEvent>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let uuids: Vec<Uuid> = ids.iter().filter_map(|id| Uuid::parse_str(id).ok()).collect();
        if uuids.is_empty() {
            return Ok(Vec::new());
        }
        // Server-side Array(UUID) membership avoids string-escaped IN lists.
        self.fetch_events_bound(&format!("{EVENT_SELECT} WHERE id IN {{ids:Array(UUID)}}"), |q| {
            q.param("ids", uuids.as_slice())
        })
        .await
    }

    async fn usage_totals(&self) -> Result<UsageTotals> {
        let row = self
            .client
            .query(
                "SELECT count() AS events, sum(tokens_in) AS tokens_in, sum(tokens_out) AS tokens_out FROM traffic_events",
            )
            .fetch_one::<UsageTotalsRow>()
            .await
            .unwrap_or(UsageTotalsRow { events: 0, tokens_in: 0, tokens_out: 0 });
        Ok(UsageTotals { events: row.events, tokens_in: row.tokens_in, tokens_out: row.tokens_out })
    }

    async fn export_all(&self) -> Result<Vec<TrafficEvent>> {
        self.fetch_events(&format!("{EVENT_SELECT} ORDER BY ts ASC")).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embeddings_ddl_declares_hnsw() {
        assert!(EMBEDDINGS_DDL.contains("vector_similarity('hnsw', 'cosineDistance', 64)"));
        assert!(EMBEDDINGS_DDL.contains("ReplacingMergeTree"));
    }

    #[test]
    fn normalize_adds_scheme() {
        assert_eq!(normalize_http_url("127.0.0.1:8123"), "http://127.0.0.1:8123");
        assert_eq!(normalize_http_url("http://127.0.0.1:8123/"), "http://127.0.0.1:8123");
    }
}
