//! `ClickHouse` traffic store — sole persistence for captured events + embeddings.

use std::collections::HashSet;

use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use chrono::{NaiveDateTime, TimeZone, Utc};
use rivet_core::{
    CaptureQuality, ProviderKind, TrafficEvent, TrafficRole, UsageTotals, LEXICAL_EMBED_DIMS,
    LEXICAL_SPACE,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tracing::{info, warn};
use uuid::Uuid;

use crate::TrafficStore;

/// DDL matching the architecture doc — apply once when the CH sidecar boots.
pub const TRAFFIC_EVENTS_DDL: &str = r"
CREATE TABLE IF NOT EXISTS traffic_events (
  id UUID,
  ts DateTime64(3, 'UTC'),
  provider LowCardinality(String),
  account_label Nullable(String),
  model LowCardinality(Nullable(String)),
  session_id Nullable(String),
  project_id Nullable(String),
  cwd Nullable(String),
  request_id Nullable(String),
  role LowCardinality(String),
  content Nullable(String),
  tokens_in UInt32,
  tokens_out UInt32,
  latency_ms Nullable(UInt64),
  status_code Nullable(UInt16),
  body_ref Nullable(String),
  capture_quality LowCardinality(Nullable(String))
) ENGINE = MergeTree
ORDER BY (ts, id);
";

const TRAFFIC_EVENTS_ADD_CAPTURE_QUALITY: &str = r"
ALTER TABLE traffic_events
  ADD COLUMN IF NOT EXISTS capture_quality LowCardinality(Nullable(String))
";

const TRAFFIC_EVENTS_ADD_CWD: &str = r"
ALTER TABLE traffic_events
  ADD COLUMN IF NOT EXISTS cwd Nullable(String)
";

/// Lexical (64-dim) vectors with a `ClickHouse` HNSW `vector_similarity` index.
pub const EMBEDDINGS_DDL: &str = r"
CREATE TABLE IF NOT EXISTS embeddings (
  event_id UUID,
  space LowCardinality(String),
  dims Array(Float32),
  updated_at DateTime64(3, 'UTC'),
  INDEX vec_hnsw dims TYPE vector_similarity('hnsw', 'cosineDistance', 64)
) ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (space, event_id);
";

/// One ANN hit from [`ClickHouseTrafficStore::search_embeddings`].
#[derive(Debug, Clone, PartialEq)]
pub struct EmbeddingSearchHit {
    pub event_id: String,
    /// `cosineDistance` (0 = identical for unit vectors).
    pub distance: f32,
}

#[derive(Clone, Debug)]
struct HttpEndpoint {
    host: String,
    port: u16,
}

impl HttpEndpoint {
    fn parse(raw: &str) -> Result<Self> {
        let raw = raw.trim().trim_end_matches('/');
        let without =
            raw.strip_prefix("http://").or_else(|| raw.strip_prefix("https://")).unwrap_or(raw);
        let (host, port) = if let Some((h, p)) = without.split_once(':') {
            let port: u16 =
                p.split('/').next().unwrap_or("8123").parse().context("clickhouse port")?;
            (h.to_string(), port)
        } else {
            let host = without.split('/').next().unwrap_or("127.0.0.1").to_string();
            (host, 8123)
        };
        Ok(Self { host, port })
    }
}

#[derive(Debug, Default, serde::Deserialize)]
struct UsageTotalsRow {
    #[serde(default)]
    events: u64,
    #[serde(default)]
    tokens_in: u64,
    #[serde(default)]
    tokens_out: u64,
}

#[derive(Debug, Default, serde::Deserialize)]
struct EmbeddingCountRow {
    #[serde(default)]
    n: u64,
}

#[derive(Debug, serde::Deserialize)]
struct EmbeddingIdRow {
    event_id: String,
}

#[derive(Debug, serde::Deserialize)]
struct EmbeddingHitRow {
    event_id: String,
    distance: f32,
}

fn format_f32_array(dims: &[f32]) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(dims.len() * 8 + 2);
    out.push('[');
    for (i, x) in dims.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        // Force decimal form so ClickHouse parses as Float, not Int.
        let _ = write!(out, "{x:.8}");
    }
    out.push(']');
    out
}

/// HTTP client for a single-node `ClickHouse` (tiny tokio TCP — no reqwest).
#[derive(Debug)]
pub struct ClickHouseTrafficStore {
    endpoint: HttpEndpoint,
    database: String,
}

impl ClickHouseTrafficStore {
    pub fn new(http_base: impl AsRef<str>) -> Result<Self> {
        Ok(Self { endpoint: HttpEndpoint::parse(http_base.as_ref())?, database: "rivet".into() })
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
        self.exec_sql_on("default", &format!("CREATE DATABASE IF NOT EXISTS {}", self.database))
            .await?;
        self.exec_sql_on(&self.database, TRAFFIC_EVENTS_DDL).await?;
        // Existing installs created before capture_quality / cwd existed.
        self.exec_sql_on(&self.database, TRAFFIC_EVENTS_ADD_CAPTURE_QUALITY).await?;
        self.exec_sql_on(&self.database, TRAFFIC_EVENTS_ADD_CWD).await?;
        self.exec_sql_on(&self.database, EMBEDDINGS_DDL).await?;
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
        let now = Utc::now().format("%Y-%m-%d %H:%M:%S%.3f").to_string();
        let mut body = String::new();
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
            if Uuid::parse_str(event_id).is_err() {
                warn!(%event_id, "skip embedding with non-UUID event id");
                continue;
            }
            let row = serde_json::json!({
                "event_id": event_id,
                "space": space,
                "dims": dims,
                "updated_at": now,
            });
            body.push_str(&serde_json::to_string(&row)?);
            body.push('\n');
            n += 1;
        }
        if n == 0 {
            return Ok(0);
        }
        let path = format!(
            "/?database={}&query=INSERT%20INTO%20embeddings%20FORMAT%20JSONEachRow",
            self.database
        );
        self.http_post(&path, "application/json", body.as_bytes()).await?;
        Ok(n)
    }

    /// Event ids that already have at least one row in `space` (duplicates ok).
    pub async fn embedded_event_ids(&self, space: &str) -> Result<HashSet<String>> {
        let space = Self::escape_literal(space);
        let body = self
            .query_json_rows(&format!(
                "SELECT DISTINCT toString(event_id) AS event_id FROM embeddings WHERE space = '{space}'"
            ))
            .await?;
        let mut out = HashSet::new();
        for line in body.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let row: EmbeddingIdRow = serde_json::from_str(line)
                .with_context(|| format!("parse embedding id row: {line}"))?;
            out.insert(row.event_id);
        }
        Ok(out)
    }

    pub async fn embedding_count(&self, space: &str) -> Result<u64> {
        let space = Self::escape_literal(space);
        let body = self
            .query_json_rows(&format!(
                "SELECT uniqExact(event_id) AS n FROM embeddings WHERE space = '{space}'"
            ))
            .await?;
        let line = body.lines().find(|l| !l.trim().is_empty()).unwrap_or("{\"n\":0}");
        let row: EmbeddingCountRow = serde_json::from_str(line).unwrap_or_default();
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
        let space_lit = Self::escape_literal(space);
        let q = format_f32_array(query_dims);
        // Fetch a small overscan so ReplacingMergeTree duplicates can be collapsed.
        let fetch = limit.saturating_mul(4).max(limit);
        let body = self
            .query_json_rows(&format!(
                "WITH {q} AS q SELECT toString(event_id) AS event_id, cosineDistance(dims, q) AS distance \
                 FROM embeddings WHERE space = '{space_lit}' AND length(dims) = {dim} \
                 ORDER BY distance ASC LIMIT {fetch}",
                dim = query_dims.len(),
            ))
            .await?;

        let mut hits = Vec::new();
        let mut seen = HashSet::new();
        for line in body.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let row: EmbeddingHitRow = serde_json::from_str(line)
                .with_context(|| format!("parse embedding hit: {line}"))?;
            if !seen.insert(row.event_id.clone()) {
                continue;
            }
            hits.push(EmbeddingSearchHit { event_id: row.event_id, distance: row.distance });
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

    async fn exec_sql_on(&self, database: &str, sql: &str) -> Result<()> {
        let path = format!("/?database={database}");
        self.http_post(&path, "text/plain; charset=utf-8", sql.as_bytes()).await?;
        Ok(())
    }

    async fn query_json_rows(&self, sql: &str) -> Result<String> {
        let path = format!("/?database={}", self.database);
        let body = format!("{sql} FORMAT JSONEachRow");
        self.http_post(&path, "text/plain; charset=utf-8", body.as_bytes()).await
    }

    async fn http_post(&self, path: &str, content_type: &str, body: &[u8]) -> Result<String> {
        let mut stream = TcpStream::connect((self.endpoint.host.as_str(), self.endpoint.port))
            .await
            .with_context(|| {
                format!("connect clickhouse {}:{}", self.endpoint.host, self.endpoint.port)
            })?;
        // HTTP/1.0 avoids Transfer-Encoding: chunked from ClickHouse; our tiny
        // client otherwise treats chunk-size lines (e.g. "38081") as JSON rows.
        let header = format!(
            "POST {path} HTTP/1.0\r\nHost: {host}:{port}\r\nContent-Type: {content_type}\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n",
            host = self.endpoint.host,
            port = self.endpoint.port,
            len = body.len(),
        );
        stream.write_all(header.as_bytes()).await?;
        stream.write_all(body).await?;
        stream.flush().await?;

        let mut buf = Vec::new();
        stream.read_to_end(&mut buf).await?;
        let text = String::from_utf8_lossy(&buf);
        let status_line = text.lines().next().unwrap_or("");
        if !status_line.contains(" 200 ") && !status_line.ends_with(" 200") {
            bail!("clickhouse HTTP error: {status_line} — {text}");
        }
        let (headers, raw_body) = match text.split_once("\r\n\r\n") {
            Some((h, b)) => (h, b),
            None => match text.split_once("\n\n") {
                Some((h, b)) => (h, b),
                None => ("", ""),
            },
        };
        Ok(decode_http_body(headers, raw_body))
    }

    fn event_row(event: &TrafficEvent) -> Result<String> {
        let provider = event.provider.as_str();
        let role = serde_json::to_value(event.role)?.as_str().unwrap_or("unknown").to_string();
        let row = serde_json::json!({
            "id": event.id.to_string(),
            "ts": event.ts.format("%Y-%m-%d %H:%M:%S%.3f").to_string(),
            "provider": provider,
            "account_label": event.account_label,
            "model": event.model,
            "session_id": event.session_id,
            "project_id": event.project_id,
            "cwd": event.cwd,
            "request_id": event.request_id,
            "role": role,
            "content": event.content,
            "tokens_in": event.tokens_in,
            "tokens_out": event.tokens_out,
            "latency_ms": event.latency_ms,
            "status_code": event.status_code,
            "body_ref": event.body_ref,
            "capture_quality": event.capture_quality.map(CaptureQuality::as_str),
        });
        Ok(serde_json::to_string(&row)?)
    }

    fn parse_events(body: &str) -> Result<Vec<TrafficEvent>> {
        let mut out = Vec::new();
        for line in body.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let row: ChEventRow =
                serde_json::from_str(line).with_context(|| format!("parse traffic row: {line}"))?;
            out.push(row.into_event()?);
        }
        Ok(out)
    }

    fn escape_literal(s: &str) -> String {
        s.replace('\\', "\\\\").replace('\'', "\\'")
    }
}

#[derive(serde::Deserialize)]
struct ChEventRow {
    id: String,
    ts: String,
    provider: String,
    #[serde(default)]
    account_label: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    project_id: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    request_id: Option<String>,
    role: String,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    tokens_in: u32,
    #[serde(default)]
    tokens_out: u32,
    #[serde(default)]
    latency_ms: Option<u64>,
    #[serde(default)]
    status_code: Option<u16>,
    #[serde(default)]
    body_ref: Option<String>,
    #[serde(default)]
    capture_quality: Option<String>,
}

impl ChEventRow {
    fn into_event(self) -> Result<TrafficEvent> {
        let id = Uuid::parse_str(&self.id).context("event id")?;
        let ts = parse_ch_ts(&self.ts)?;
        let role = match self.role.as_str() {
            "system" => TrafficRole::System,
            "user" => TrafficRole::User,
            "assistant" => TrafficRole::Assistant,
            "tool" => TrafficRole::Tool,
            _ => TrafficRole::Unknown,
        };
        let capture_quality = self.capture_quality.as_deref().map(CaptureQuality::parse);
        Ok(TrafficEvent {
            id,
            ts,
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
            capture_quality,
        })
    }
}

/// Decode an HTTP response body, unwrapping `Transfer-Encoding: chunked` when present.
fn decode_http_body(headers: &str, body: &str) -> String {
    let chunked = headers.lines().any(|line| {
        let line = line.trim();
        let Some((name, value)) = line.split_once(':') else {
            return false;
        };
        name.eq_ignore_ascii_case("transfer-encoding")
            && value.split(',').any(|p| p.trim().eq_ignore_ascii_case("chunked"))
    });
    if !chunked {
        return body.to_string();
    }
    let mut out = String::new();
    let mut rest = body;
    while !rest.is_empty() {
        let (size_line, after) = match rest.split_once("\r\n") {
            Some(pair) => pair,
            None => match rest.split_once('\n') {
                Some(pair) => pair,
                None => break,
            },
        };
        let size_hex = size_line.split(';').next().unwrap_or("").trim();
        let Ok(size) = usize::from_str_radix(size_hex, 16) else {
            // Not a valid chunk stream — return raw body rather than drop data.
            return body.to_string();
        };
        if size == 0 {
            break;
        }
        if after.len() < size {
            out.push_str(after);
            break;
        }
        out.push_str(&after[..size]);
        rest = &after[size..];
        if let Some(stripped) = rest.strip_prefix("\r\n") {
            rest = stripped;
        } else if let Some(stripped) = rest.strip_prefix('\n') {
            rest = stripped;
        }
    }
    out
}

fn parse_ch_ts(raw: &str) -> Result<chrono::DateTime<Utc>> {
    let raw = raw.trim();
    // DateTime64 JSON: "2024-01-02 03:04:05.678" or with Z / offset
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(raw) {
        return Ok(dt.with_timezone(&Utc));
    }
    let naive = NaiveDateTime::parse_from_str(raw, "%Y-%m-%d %H:%M:%S%.3f")
        .or_else(|_| NaiveDateTime::parse_from_str(raw, "%Y-%m-%d %H:%M:%S"))
        .with_context(|| format!("clickhouse ts: {raw}"))?;
    Ok(Utc.from_utc_datetime(&naive))
}

#[async_trait]
impl TrafficStore for ClickHouseTrafficStore {
    async fn insert_event(&self, event: &TrafficEvent) -> Result<()> {
        let row = Self::event_row(event)?;
        let path = format!(
            "/?database={}&query=INSERT%20INTO%20traffic_events%20FORMAT%20JSONEachRow",
            self.database
        );
        self.http_post(&path, "application/json", row.as_bytes()).await?;
        Ok(())
    }

    async fn insert_batch(&self, events: &[TrafficEvent]) -> Result<()> {
        if events.is_empty() {
            return Ok(());
        }
        let mut body = String::new();
        for event in events {
            body.push_str(&Self::event_row(event)?);
            body.push('\n');
        }
        let path = format!(
            "/?database={}&query=INSERT%20INTO%20traffic_events%20FORMAT%20JSONEachRow",
            self.database
        );
        self.http_post(&path, "application/json", body.as_bytes()).await?;
        Ok(())
    }

    async fn recent(&self, limit: u32) -> Result<Vec<TrafficEvent>> {
        let limit = limit.clamp(1, 5000);
        let body = self
            .query_json_rows(&format!(
                "SELECT id, ts, provider, account_label, model, session_id, project_id, cwd, request_id, role, content, tokens_in, tokens_out, latency_ms, status_code, body_ref, capture_quality FROM traffic_events ORDER BY ts DESC LIMIT {limit}"
            ))
            .await?;
        Self::parse_events(&body)
    }

    async fn search_keyword(&self, query: &str, limit: u32) -> Result<Vec<TrafficEvent>> {
        let limit = limit.clamp(1, 5000);
        let q = Self::escape_literal(query.trim());
        if q.is_empty() {
            return self.recent(limit).await;
        }
        let body = self
            .query_json_rows(&format!(
                "SELECT id, ts, provider, account_label, model, session_id, project_id, cwd, request_id, role, content, tokens_in, tokens_out, latency_ms, status_code, body_ref, capture_quality FROM traffic_events WHERE positionCaseInsensitive(ifNull(content, ''), '{q}') > 0 OR positionCaseInsensitive(ifNull(model, ''), '{q}') > 0 OR positionCaseInsensitive(ifNull(account_label, ''), '{q}') > 0 OR positionCaseInsensitive(ifNull(session_id, ''), '{q}') > 0 ORDER BY ts DESC LIMIT {limit}"
            ))
            .await?;
        Self::parse_events(&body)
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
            let eid = Self::escape_literal(event_id);
            let body = self
                .query_json_rows(&format!(
                    "SELECT id, ts, provider, account_label, model, session_id, project_id, cwd, request_id, role, content, tokens_in, tokens_out, latency_ms, status_code, body_ref, capture_quality FROM traffic_events WHERE toString(id) = '{eid}' ORDER BY ts ASC LIMIT {limit}"
                ))
                .await?;
            return Self::parse_events(&body);
        }
        let sid = Self::escape_literal(id);
        let body = self
            .query_json_rows(&format!(
                "SELECT id, ts, provider, account_label, model, session_id, project_id, cwd, request_id, role, content, tokens_in, tokens_out, latency_ms, status_code, body_ref, capture_quality FROM traffic_events WHERE session_id = '{sid}' ORDER BY ts ASC LIMIT {limit}"
            ))
            .await?;
        Self::parse_events(&body)
    }

    async fn get_by_ids(&self, ids: &[String]) -> Result<Vec<TrafficEvent>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let list = ids
            .iter()
            .map(|id| format!("'{}'", Self::escape_literal(id)))
            .collect::<Vec<_>>()
            .join(",");
        let body = self
            .query_json_rows(&format!(
                "SELECT id, ts, provider, account_label, model, session_id, project_id, cwd, request_id, role, content, tokens_in, tokens_out, latency_ms, status_code, body_ref, capture_quality FROM traffic_events WHERE toString(id) IN ({list})"
            ))
            .await?;
        Self::parse_events(&body)
    }

    async fn usage_totals(&self) -> Result<UsageTotals> {
        let body = self
            .query_json_rows(
                "SELECT count() AS events, sum(tokens_in) AS tokens_in, sum(tokens_out) AS tokens_out FROM traffic_events",
            )
            .await?;
        let line = body.lines().find(|l| !l.trim().is_empty()).unwrap_or("{}");
        let t: UsageTotalsRow = serde_json::from_str(line).unwrap_or_default();
        Ok(UsageTotals { events: t.events, tokens_in: t.tokens_in, tokens_out: t.tokens_out })
    }

    async fn export_all(&self) -> Result<Vec<TrafficEvent>> {
        let body = self
            .query_json_rows(
                "SELECT id, ts, provider, account_label, model, session_id, project_id, cwd, request_id, role, content, tokens_in, tokens_out, latency_ms, status_code, body_ref, capture_quality FROM traffic_events ORDER BY ts ASC",
            )
            .await?;
        Self::parse_events(&body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_f32_array_is_bracketed() {
        let s = format_f32_array(&[1.0, -0.5, 0.0]);
        assert!(s.starts_with('['));
        assert!(s.ends_with(']'));
        assert!(s.contains("1.00000000"));
        assert!(s.contains("-0.50000000"));
    }

    #[test]
    fn embeddings_ddl_declares_hnsw() {
        assert!(EMBEDDINGS_DDL.contains("vector_similarity('hnsw', 'cosineDistance', 64)"));
        assert!(EMBEDDINGS_DDL.contains("ReplacingMergeTree"));
    }
}
