//! ClickHouse-shaped traffic store.
//!
//! Local DMG still defaults to SQLite. When a ClickHouse HTTP endpoint is
//! configured (`RIVET_CLICKHOUSE_URL`, e.g. `http://127.0.0.1:8123`), inserts
//! dual-write here. Full query/export against CH lands when the sidecar is
//! bundled — until then reads stay on SQLite via [`DualWriteStore`].

use std::sync::Arc;

use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use rivet_core::{TrafficEvent, UsageTotals};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tracing::warn;

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

/// HTTP insert client for a single-node ClickHouse.
///
/// Uses a tiny tokio TCP client (no reqwest) so the workspace stays on rustc 1.86.
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
        // CREATE DATABASE against the default DB (rivet may not exist yet).
        self.exec_sql_on("default", &format!("CREATE DATABASE IF NOT EXISTS {}", self.database))
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

    async fn http_post(&self, path: &str, content_type: &str, body: &[u8]) -> Result<String> {
        let mut stream = TcpStream::connect((self.endpoint.host.as_str(), self.endpoint.port))
            .await
            .with_context(|| {
                format!(
                    "connect clickhouse {}:{}",
                    self.endpoint.host, self.endpoint.port
                )
            })?;
        let header = format!(
            "POST {path} HTTP/1.1\r\nHost: {host}:{port}\r\nContent-Type: {content_type}\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n",
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
        Ok(text.into_owned())
    }

    fn event_row(event: &TrafficEvent) -> Result<String> {
        let provider = serde_json::to_value(event.provider)?
            .as_str()
            .unwrap_or("other")
            .to_string();
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

    async fn recent(&self, _limit: u32) -> Result<Vec<TrafficEvent>> {
        warn!("ClickHouse recent() not used locally — reads go through SQLite");
        bail!("clickhouse reads not enabled until sidecar is primary")
    }

    async fn search_keyword(&self, _query: &str, _limit: u32) -> Result<Vec<TrafficEvent>> {
        bail!("clickhouse search not enabled until sidecar is primary")
    }

    async fn get_by_ids(&self, _ids: &[String]) -> Result<Vec<TrafficEvent>> {
        bail!("clickhouse get_by_ids not enabled until sidecar is primary")
    }

    async fn usage_totals(&self) -> Result<UsageTotals> {
        bail!("clickhouse totals not enabled until sidecar is primary")
    }

    async fn export_all(&self) -> Result<Vec<TrafficEvent>> {
        bail!("clickhouse export not enabled until sidecar is primary")
    }
}

/// Primary SQLite + optional best-effort ClickHouse insert path.
pub struct DualWriteStore {
    primary: Arc<dyn TrafficStore>,
    secondary: Option<Arc<dyn TrafficStore>>,
}

impl DualWriteStore {
    pub fn new(
        primary: Arc<dyn TrafficStore>,
        secondary: Option<Arc<dyn TrafficStore>>,
    ) -> Self {
        Self {
            primary,
            secondary,
        }
    }
}

#[async_trait]
impl TrafficStore for DualWriteStore {
    async fn insert_event(&self, event: &TrafficEvent) -> Result<()> {
        self.primary.insert_event(event).await?;
        if let Some(sec) = &self.secondary {
            if let Err(err) = sec.insert_event(event).await {
                warn!(?err, "clickhouse dual-write insert failed");
            }
        }
        Ok(())
    }

    async fn insert_batch(&self, events: &[TrafficEvent]) -> Result<()> {
        self.primary.insert_batch(events).await?;
        if let Some(sec) = &self.secondary {
            if let Err(err) = sec.insert_batch(events).await {
                warn!(?err, "clickhouse dual-write batch failed");
            }
        }
        Ok(())
    }

    async fn recent(&self, limit: u32) -> Result<Vec<TrafficEvent>> {
        self.primary.recent(limit).await
    }

    async fn search_keyword(&self, query: &str, limit: u32) -> Result<Vec<TrafficEvent>> {
        self.primary.search_keyword(query, limit).await
    }

    async fn get_by_ids(&self, ids: &[String]) -> Result<Vec<TrafficEvent>> {
        self.primary.get_by_ids(ids).await
    }

    async fn usage_totals(&self) -> Result<UsageTotals> {
        self.primary.usage_totals().await
    }

    async fn export_all(&self) -> Result<Vec<TrafficEvent>> {
        self.primary.export_all().await
    }
}
