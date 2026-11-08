//! ClickHouse traffic store — sole persistence for captured events.

use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use chrono::{NaiveDateTime, TimeZone, Utc};
use rivet_core::{ProviderKind, TrafficEvent, TrafficRole, UsageTotals};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tracing::warn;
use uuid::Uuid;

use crate::TrafficStore;

/// DDL matching the architecture doc — apply once when the CH sidecar boots.
pub const TRAFFIC_EVENTS_DDL: &str = r#"
CREATE TABLE IF NOT EXISTS traffic_events (
  id UUID,
  ts DateTime64(3, 'UTC'),
  provider LowCardinality(String),
  account_label Nullable(String),
  model LowCardinality(Nullable(String)),
  session_id Nullable(String),
  project_id Nullable(String),
  request_id Nullable(String),
  role LowCardinality(String),
  content Nullable(String),
  tokens_in UInt32,
  tokens_out UInt32,
  latency_ms Nullable(UInt64),
  status_code Nullable(UInt16),
  body_ref Nullable(String)
) ENGINE = MergeTree
ORDER BY (ts, id);
"#;

#[derive(Clone)]
struct HttpEndpoint {
    host: String,
    port: u16,
}

impl HttpEndpoint {
    fn parse(raw: &str) -> Result<Self> {
        let raw = raw.trim().trim_end_matches('/');
        let without = raw
            .strip_prefix("http://")
            .or_else(|| raw.strip_prefix("https://"))
            .unwrap_or(raw);
        let (host, port) = if let Some((h, p)) = without.split_once(':') {
            let port: u16 = p
                .split('/')
                .next()
                .unwrap_or("8123")
                .parse()
                .context("clickhouse port")?;
            (h.to_string(), port)
        } else {
            let host = without.split('/').next().unwrap_or("127.0.0.1").to_string();
            (host, 8123)
        };
        Ok(Self { host, port })
    }
}

/// HTTP client for a single-node ClickHouse (tiny tokio TCP — no reqwest).
pub struct ClickHouseTrafficStore {
    endpoint: HttpEndpoint,
    database: String,
}

impl ClickHouseTrafficStore {
    pub fn new(http_base: impl AsRef<str>) -> Result<Self> {
        Ok(Self {
            endpoint: HttpEndpoint::parse(http_base.as_ref())?,
            database: "rivet".into(),
        })
    }

    pub fn from_env() -> Option<Self> {
        Self::from_env_url().and_then(|url| match Self::new(&url) {
            Ok(s) => Some(s),
            Err(err) => {
                warn!(?err, "invalid RIVET_CLICKHOUSE_URL");
                None
            }
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
        self.exec_sql_on(
            "default",
            &format!("CREATE DATABASE IF NOT EXISTS {}", self.database),
        )
        .await?;
        self.exec_sql_on(&self.database, TRAFFIC_EVENTS_DDL).await?;
        Ok(())
    }

    async fn exec_sql_on(&self, database: &str, sql: &str) -> Result<()> {
        let path = format!("/?database={database}");
        self.http_post(&path, "text/plain; charset=utf-8", sql.as_bytes())
            .await?;
        Ok(())
    }

    async fn query_json_rows(&self, sql: &str) -> Result<String> {
        let path = format!("/?database={}", self.database);
        let body = format!("{sql} FORMAT JSONEachRow");
        self.http_post(&path, "text/plain; charset=utf-8", body.as_bytes())
            .await
    }

    async fn http_post(&self, path: &str, content_type: &str, body: &[u8]) -> Result<String> {
        let mut stream = TcpStream::connect((self.endpoint.host.as_str(), self.endpoint.port))
            .await
            .with_context(|| {
                format!(
                    "connect clickhouse {}:{}",
                    self.endpoint.host, self.endpoint.port
                )
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
        let role = serde_json::to_value(event.role)?
            .as_str()
            .unwrap_or("unknown")
            .to_string();
        let row = serde_json::json!({
            "id": event.id.to_string(),
            "ts": event.ts.format("%Y-%m-%d %H:%M:%S%.3f").to_string(),
            "provider": provider,
            "account_label": event.account_label,
            "model": event.model,
            "session_id": event.session_id,
            "project_id": event.project_id,
            "request_id": event.request_id,
            "role": role,
            "content": event.content,
            "tokens_in": event.tokens_in,
            "tokens_out": event.tokens_out,
            "latency_ms": event.latency_ms,
            "status_code": event.status_code,
            "body_ref": event.body_ref,
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
        Ok(TrafficEvent {
            id,
            ts,
            provider: ProviderKind::parse(&self.provider),
            account_label: self.account_label,
            model: self.model,
            session_id: self.session_id,
            project_id: self.project_id,
            request_id: self.request_id,
            role,
            content: self.content,
            tokens_in: self.tokens_in,
            tokens_out: self.tokens_out,
            latency_ms: self.latency_ms,
            status_code: self.status_code,
            body_ref: self.body_ref,
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
        self.http_post(&path, "application/json", row.as_bytes())
            .await?;
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
        self.http_post(&path, "application/json", body.as_bytes())
            .await?;
        Ok(())
    }

    async fn recent(&self, limit: u32) -> Result<Vec<TrafficEvent>> {
        let limit = limit.clamp(1, 5000);
        let body = self
            .query_json_rows(&format!(
                "SELECT id, ts, provider, account_label, model, session_id, project_id, request_id, role, content, tokens_in, tokens_out, latency_ms, status_code, body_ref FROM traffic_events ORDER BY ts DESC LIMIT {limit}"
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
                "SELECT id, ts, provider, account_label, model, session_id, project_id, request_id, role, content, tokens_in, tokens_out, latency_ms, status_code, body_ref FROM traffic_events WHERE positionCaseInsensitive(ifNull(content, ''), '{q}') > 0 OR positionCaseInsensitive(ifNull(model, ''), '{q}') > 0 OR positionCaseInsensitive(ifNull(account_label, ''), '{q}') > 0 ORDER BY ts DESC LIMIT {limit}"
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
                "SELECT id, ts, provider, account_label, model, session_id, project_id, request_id, role, content, tokens_in, tokens_out, latency_ms, status_code, body_ref FROM traffic_events WHERE toString(id) IN ({list})"
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
        #[derive(Default, serde::Deserialize)]
        struct Totals {
            #[serde(default)]
            events: u64,
            #[serde(default)]
            tokens_in: u64,
            #[serde(default)]
            tokens_out: u64,
        }
        let t: Totals = serde_json::from_str(line).unwrap_or_default();
        Ok(UsageTotals {
            events: t.events,
            tokens_in: t.tokens_in,
            tokens_out: t.tokens_out,
        })
    }

    async fn export_all(&self) -> Result<Vec<TrafficEvent>> {
        let body = self
            .query_json_rows(
                "SELECT id, ts, provider, account_label, model, session_id, project_id, request_id, role, content, tokens_in, tokens_out, latency_ms, status_code, body_ref FROM traffic_events ORDER BY ts ASC",
            )
            .await?;
        Self::parse_events(&body)
    }
}
