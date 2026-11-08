use anyhow::Result;
use async_trait::async_trait;
use rivet_core::{RivetPaths, TrafficEvent, UsageTotals};
use rusqlite::{params, Connection};
use std::sync::{Arc, Mutex};

use crate::TrafficStore;

#[derive(Clone)]
pub struct SqliteTrafficStore {
    conn: Arc<Mutex<Connection>>,
}

impl SqliteTrafficStore {
    pub fn open(paths: &RivetPaths) -> Result<Self> {
        let path = paths.root.join("traffic.sqlite");
        let conn = Connection::open(path.as_std_path())?;
        conn.execute_batch(
            r#"
            PRAGMA journal_mode=WAL;
            PRAGMA synchronous=NORMAL;
            CREATE TABLE IF NOT EXISTS traffic_events (
              id TEXT PRIMARY KEY,
              ts TEXT NOT NULL,
              provider TEXT NOT NULL,
              account_label TEXT,
              model TEXT,
              session_id TEXT,
              project_id TEXT,
              request_id TEXT,
              role TEXT NOT NULL,
              content TEXT,
              tokens_in INTEGER NOT NULL,
              tokens_out INTEGER NOT NULL,
              latency_ms INTEGER,
              status_code INTEGER,
              body_ref TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_traffic_ts ON traffic_events(ts DESC);
            CREATE INDEX IF NOT EXISTS idx_traffic_session ON traffic_events(session_id);
            CREATE INDEX IF NOT EXISTS idx_traffic_project ON traffic_events(project_id);
            "#,
        )?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    fn insert_locked(conn: &Connection, event: &TrafficEvent) -> Result<()> {
        conn.execute(
            r#"
            INSERT OR REPLACE INTO traffic_events (
              id, ts, provider, account_label, model, session_id, project_id,
              request_id, role, content, tokens_in, tokens_out, latency_ms,
              status_code, body_ref
            ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)
            "#,
            params![
                event.id.to_string(),
                event.ts.to_rfc3339(),
                serde_json::to_value(event.provider)?
                    .as_str()
                    .unwrap_or("other")
                    .to_string(),
                event.account_label,
                event.model,
                event.session_id,
                event.project_id,
                event.request_id,
                serde_json::to_value(event.role)?
                    .as_str()
                    .unwrap_or("unknown")
                    .to_string(),
                event.content,
                event.tokens_in,
                event.tokens_out,
                event.latency_ms.map(|v| v as i64),
                event.status_code.map(|v| v as i64),
                event.body_ref,
            ],
        )?;
        Ok(())
    }

    fn row_to_event(row: &rusqlite::Row<'_>) -> rusqlite::Result<TrafficEvent> {
        let id: String = row.get(0)?;
        let ts: String = row.get(1)?;
        let provider: String = row.get(2)?;
        let role: String = row.get(8)?;
        Ok(TrafficEvent {
            id: uuid::Uuid::parse_str(&id).unwrap_or_default(),
            ts: chrono::DateTime::parse_from_rfc3339(&ts)
                .map(|d| d.with_timezone(&chrono::Utc))
                .unwrap_or_else(|_| chrono::Utc::now()),
            provider: serde_json::from_value(serde_json::Value::String(provider))
                .unwrap_or(rivet_core::ProviderKind::Other),
            account_label: row.get(3)?,
            model: row.get(4)?,
            session_id: row.get(5)?,
            project_id: row.get(6)?,
            request_id: row.get(7)?,
            role: serde_json::from_value(serde_json::Value::String(role))
                .unwrap_or(rivet_core::TrafficRole::Unknown),
            content: row.get(9)?,
            tokens_in: row.get::<_, i64>(10)? as u32,
            tokens_out: row.get::<_, i64>(11)? as u32,
            latency_ms: row
                .get::<_, Option<i64>>(12)?
                .map(|v| v as u64),
            status_code: row
                .get::<_, Option<i64>>(13)?
                .map(|v| v as u16),
            body_ref: row.get(14)?,
        })
    }
}

#[async_trait]
impl TrafficStore for SqliteTrafficStore {
    async fn insert_event(&self, event: &TrafficEvent) -> Result<()> {
        let conn = self.conn.lock().expect("traffic lock");
        Self::insert_locked(&conn, event)
    }

    async fn insert_batch(&self, events: &[TrafficEvent]) -> Result<()> {
        let conn = self.conn.lock().expect("traffic lock");
        let tx = conn.unchecked_transaction()?;
        for event in events {
            Self::insert_locked(&tx, event)?;
        }
        tx.commit()?;
        Ok(())
    }

    async fn recent(&self, limit: u32) -> Result<Vec<TrafficEvent>> {
        let conn = self.conn.lock().expect("traffic lock");
        let mut stmt = conn.prepare(
            "SELECT id, ts, provider, account_label, model, session_id, project_id,
                    request_id, role, content, tokens_in, tokens_out, latency_ms,
                    status_code, body_ref
             FROM traffic_events ORDER BY ts DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit], Self::row_to_event)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    async fn search_keyword(&self, query: &str, limit: u32) -> Result<Vec<TrafficEvent>> {
        let conn = self.conn.lock().expect("traffic lock");
        // Prefer FTS when query is non-empty; fall back to LIKE.
        let mut stmt = conn.prepare(
            "SELECT e.id, e.ts, e.provider, e.account_label, e.model, e.session_id, e.project_id,
                    e.request_id, e.role, e.content, e.tokens_in, e.tokens_out, e.latency_ms,
                    e.status_code, e.body_ref
             FROM traffic_events e
             WHERE e.content LIKE ?1 OR e.model LIKE ?1 OR e.session_id LIKE ?1
             ORDER BY e.ts DESC LIMIT ?2",
        )?;
        let pattern = format!("%{query}%");
        let rows = stmt.query_map(params![pattern, limit], Self::row_to_event)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    async fn get_by_ids(&self, ids: &[String]) -> Result<Vec<TrafficEvent>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.conn.lock().expect("traffic lock");
        let mut out = Vec::new();
        for id in ids {
            let mut stmt = conn.prepare(
                "SELECT id, ts, provider, account_label, model, session_id, project_id,
                        request_id, role, content, tokens_in, tokens_out, latency_ms,
                        status_code, body_ref
                 FROM traffic_events WHERE id = ?1",
            )?;
            let mut rows = stmt.query_map(params![id], Self::row_to_event)?;
            if let Some(row) = rows.next() {
                out.push(row?);
            }
        }
        Ok(out)
    }

    async fn usage_totals(&self) -> Result<UsageTotals> {
        let conn = self.conn.lock().expect("traffic lock");
        conn.query_row(
            "SELECT COUNT(*), COALESCE(SUM(tokens_in),0), COALESCE(SUM(tokens_out),0) FROM traffic_events",
            [],
            |r| {
                Ok(UsageTotals {
                    events: r.get::<_, i64>(0)? as u64,
                    tokens_in: r.get::<_, i64>(1)? as u64,
                    tokens_out: r.get::<_, i64>(2)? as u64,
                })
            },
        )
        .map_err(Into::into)
    }

    async fn export_all(&self) -> Result<Vec<TrafficEvent>> {
        let conn = self.conn.lock().expect("traffic lock");
        let mut stmt = conn.prepare(
            "SELECT id, ts, provider, account_label, model, session_id, project_id,
                    request_id, role, content, tokens_in, tokens_out, latency_ms,
                    status_code, body_ref
             FROM traffic_events ORDER BY ts ASC",
        )?;
        let rows = stmt.query_map([], Self::row_to_event)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }
}
