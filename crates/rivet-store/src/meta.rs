use anyhow::Result;
use chrono::Utc;
use rivet_core::RivetPaths;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WikiPageMeta {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub path: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbeddingRow {
    pub event_id: String,
    pub dims: Vec<f32>,
    pub updated_at: String,
}

pub struct MetaStore {
    conn: Mutex<Connection>,
}

impl MetaStore {
    pub fn open(paths: &RivetPaths) -> Result<Self> {
        let conn = Connection::open(paths.sqlite_file().as_std_path())?;
        conn.execute_batch(
            r#"
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS accounts (
              id TEXT PRIMARY KEY,
              provider TEXT NOT NULL,
              label TEXT NOT NULL,
              disabled INTEGER NOT NULL DEFAULT 0,
              reset_at TEXT,
              meta_json TEXT NOT NULL DEFAULT '{}'
            );
            CREATE TABLE IF NOT EXISTS wiki_pages (
              id TEXT PRIMARY KEY,
              project_id TEXT NOT NULL,
              title TEXT NOT NULL,
              path TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS jobs (
              name TEXT PRIMARY KEY,
              cursor TEXT,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS embeddings (
              event_id TEXT PRIMARY KEY,
              dims_json TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            "#,
        )?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn account_count(&self) -> Result<u64> {
        let conn = self.conn.lock().expect("meta lock");
        let n: u64 = conn.query_row("SELECT COUNT(*) FROM accounts", [], |r| r.get(0))?;
        Ok(n)
    }

    pub fn job_cursor(&self, name: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().expect("meta lock");
        let mut stmt = conn.prepare("SELECT cursor FROM jobs WHERE name = ?1")?;
        let mut rows = stmt.query(params![name])?;
        if let Some(row) = rows.next()? {
            Ok(row.get(0)?)
        } else {
            Ok(None)
        }
    }

    pub fn set_job_cursor(&self, name: &str, cursor: &str) -> Result<()> {
        let conn = self.conn.lock().expect("meta lock");
        conn.execute(
            "INSERT INTO jobs(name, cursor, updated_at) VALUES(?1,?2,?3)
             ON CONFLICT(name) DO UPDATE SET cursor=excluded.cursor, updated_at=excluded.updated_at",
            params![name, cursor, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    pub fn upsert_wiki_page(&self, page: &WikiPageMeta) -> Result<()> {
        let conn = self.conn.lock().expect("meta lock");
        conn.execute(
            "INSERT INTO wiki_pages(id, project_id, title, path, updated_at)
             VALUES(?1,?2,?3,?4,?5)
             ON CONFLICT(id) DO UPDATE SET
               title=excluded.title,
               path=excluded.path,
               updated_at=excluded.updated_at",
            params![
                page.id,
                page.project_id,
                page.title,
                page.path,
                page.updated_at
            ],
        )?;
        Ok(())
    }

    pub fn list_wiki_pages(&self, project_id: &str) -> Result<Vec<WikiPageMeta>> {
        let conn = self.conn.lock().expect("meta lock");
        let mut stmt = conn.prepare(
            "SELECT id, project_id, title, path, updated_at FROM wiki_pages
             WHERE project_id = ?1 ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map(params![project_id], |r| {
            Ok(WikiPageMeta {
                id: r.get(0)?,
                project_id: r.get(1)?,
                title: r.get(2)?,
                path: r.get(3)?,
                updated_at: r.get(4)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn upsert_embedding(&self, event_id: &str, dims: &[f32]) -> Result<()> {
        let conn = self.conn.lock().expect("meta lock");
        let dims_json = serde_json::to_string(dims)?;
        conn.execute(
            "INSERT INTO embeddings(event_id, dims_json, updated_at) VALUES(?1,?2,?3)
             ON CONFLICT(event_id) DO UPDATE SET dims_json=excluded.dims_json, updated_at=excluded.updated_at",
            params![event_id, dims_json, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    pub fn embedding_for(&self, event_id: &str) -> Result<Option<Vec<f32>>> {
        let conn = self.conn.lock().expect("meta lock");
        let mut stmt = conn.prepare("SELECT dims_json FROM embeddings WHERE event_id = ?1")?;
        let mut rows = stmt.query(params![event_id])?;
        if let Some(row) = rows.next()? {
            let raw: String = row.get(0)?;
            Ok(Some(serde_json::from_str(&raw)?))
        } else {
            Ok(None)
        }
    }

    pub fn all_embeddings(&self) -> Result<Vec<(String, Vec<f32>)>> {
        let conn = self.conn.lock().expect("meta lock");
        let mut stmt = conn.prepare("SELECT event_id, dims_json FROM embeddings")?;
        let rows = stmt.query_map([], |r| {
            let id: String = r.get(0)?;
            let raw: String = r.get(1)?;
            Ok((id, raw))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (id, raw) = row?;
            let dims: Vec<f32> = serde_json::from_str(&raw)?;
            out.push((id, dims));
        }
        Ok(out)
    }
}
