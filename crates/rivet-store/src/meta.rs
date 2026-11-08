//! Local meta store — jobs, wiki index, embeddings, quota history.
//! File-backed (no SQLite). Wiki page bodies live under `wiki/` on disk.

use anyhow::{Context, Result};
use chrono::Utc;
use rivet_core::RivetPaths;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct JobsFile {
    #[serde(default)]
    cursors: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct WikiFile {
    #[serde(default)]
    pages: BTreeMap<String, WikiPageMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct EmbeddingEntry {
    dims: Vec<f32>,
    updated_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct EmbeddingsFile {
    #[serde(default)]
    by_event: BTreeMap<String, EmbeddingEntry>,
}

struct MetaPaths {
    jobs: PathBuf,
    wiki: PathBuf,
    embeddings: PathBuf,
    quota: PathBuf,
}

pub struct MetaStore {
    paths: MetaPaths,
    lock: Mutex<()>,
}

impl MetaStore {
    pub fn open(paths: &RivetPaths) -> Result<Self> {
        let dir = paths.meta_dir();
        fs::create_dir_all(dir.as_std_path())?;
        // Drop legacy SQLite files if present (no migrator).
        let _ = fs::remove_file(paths.root.join("rivet.sqlite").as_std_path());
        let _ = fs::remove_file(paths.root.join("traffic.sqlite").as_std_path());
        Ok(Self {
            paths: MetaPaths {
                jobs: dir.join("jobs.json").into_std_path_buf(),
                wiki: dir.join("wiki_pages.json").into_std_path_buf(),
                embeddings: dir.join("embeddings.json").into_std_path_buf(),
                quota: dir.join("quota_snapshots.jsonl").into_std_path_buf(),
            },
            lock: Mutex::new(()),
        })
    }

    fn read_json<T: for<'de> Deserialize<'de> + Default>(path: &Path) -> Result<T> {
        if !path.exists() {
            return Ok(T::default());
        }
        let raw = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
        if raw.trim().is_empty() {
            return Ok(T::default());
        }
        Ok(serde_json::from_str(&raw).unwrap_or_default())
    }

    fn write_json_atomic(path: &Path, value: &impl Serialize) -> Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let tmp = path.with_extension("tmp");
        let data = serde_json::to_vec_pretty(value)?;
        {
            let mut f = fs::File::create(&tmp)?;
            f.write_all(&data)?;
            f.sync_all()?;
        }
        fs::rename(&tmp, path)?;
        Ok(())
    }

    pub fn job_cursor(&self, name: &str) -> Result<Option<String>> {
        let _g = self.lock.lock().expect("meta lock");
        let jobs: JobsFile = Self::read_json(&self.paths.jobs)?;
        Ok(jobs.cursors.get(name).cloned())
    }

    pub fn set_job_cursor(&self, name: &str, cursor: &str) -> Result<()> {
        let _g = self.lock.lock().expect("meta lock");
        let mut jobs: JobsFile = Self::read_json(&self.paths.jobs)?;
        jobs.cursors.insert(name.to_string(), cursor.to_string());
        Self::write_json_atomic(&self.paths.jobs, &jobs)
    }

    pub fn upsert_wiki_page(&self, page: &WikiPageMeta) -> Result<()> {
        let _g = self.lock.lock().expect("meta lock");
        let mut file: WikiFile = Self::read_json(&self.paths.wiki)?;
        file.pages.insert(page.id.clone(), page.clone());
        Self::write_json_atomic(&self.paths.wiki, &file)
    }

    pub fn list_wiki_pages(&self, project_id: &str) -> Result<Vec<WikiPageMeta>> {
        let _g = self.lock.lock().expect("meta lock");
        let file: WikiFile = Self::read_json(&self.paths.wiki)?;
        let mut out: Vec<_> = file
            .pages
            .values()
            .filter(|p| p.project_id == project_id)
            .cloned()
            .collect();
        out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(out)
    }

    pub fn list_all_wiki_pages(&self) -> Result<Vec<WikiPageMeta>> {
        let _g = self.lock.lock().expect("meta lock");
        let file: WikiFile = Self::read_json(&self.paths.wiki)?;
        let mut out: Vec<_> = file.pages.values().cloned().collect();
        out.sort_by(|a, b| {
            a.project_id
                .cmp(&b.project_id)
                .then_with(|| a.path.cmp(&b.path))
        });
        Ok(out)
    }

    pub fn get_wiki_page(&self, id: &str) -> Result<Option<WikiPageMeta>> {
        let _g = self.lock.lock().expect("meta lock");
        let file: WikiFile = Self::read_json(&self.paths.wiki)?;
        Ok(file.pages.get(id).cloned())
    }

    pub fn delete_wiki_page(&self, id: &str) -> Result<bool> {
        let _g = self.lock.lock().expect("meta lock");
        let mut file: WikiFile = Self::read_json(&self.paths.wiki)?;
        let removed = file.pages.remove(id).is_some();
        if removed {
            Self::write_json_atomic(&self.paths.wiki, &file)?;
        }
        Ok(removed)
    }

    pub fn delete_wiki_pages_for_project(&self, project_id: &str) -> Result<u64> {
        let _g = self.lock.lock().expect("meta lock");
        let mut file: WikiFile = Self::read_json(&self.paths.wiki)?;
        let before = file.pages.len();
        file.pages.retain(|_, p| p.project_id != project_id);
        let n = (before - file.pages.len()) as u64;
        if n > 0 {
            Self::write_json_atomic(&self.paths.wiki, &file)?;
        }
        Ok(n)
    }

    pub fn upsert_embedding(&self, event_id: &str, dims: &[f32]) -> Result<()> {
        let _g = self.lock.lock().expect("meta lock");
        let mut file: EmbeddingsFile = Self::read_json(&self.paths.embeddings)?;
        file.by_event.insert(
            event_id.to_string(),
            EmbeddingEntry {
                dims: dims.to_vec(),
                updated_at: Utc::now().to_rfc3339(),
            },
        );
        Self::write_json_atomic(&self.paths.embeddings, &file)
    }

    pub fn embedding_for(&self, event_id: &str) -> Result<Option<Vec<f32>>> {
        let _g = self.lock.lock().expect("meta lock");
        let file: EmbeddingsFile = Self::read_json(&self.paths.embeddings)?;
        Ok(file.by_event.get(event_id).map(|e| e.dims.clone()))
    }

    pub fn all_embeddings(&self) -> Result<Vec<(String, Vec<f32>)>> {
        let _g = self.lock.lock().expect("meta lock");
        let file: EmbeddingsFile = Self::read_json(&self.paths.embeddings)?;
        Ok(file
            .by_event
            .into_iter()
            .map(|(id, e)| (id, e.dims))
            .collect())
    }

    pub fn embedding_count(&self) -> Result<u64> {
        let _g = self.lock.lock().expect("meta lock");
        let file: EmbeddingsFile = Self::read_json(&self.paths.embeddings)?;
        Ok(file.by_event.len() as u64)
    }

    pub fn wiki_page_count(&self, project_id: &str) -> Result<u64> {
        let _g = self.lock.lock().expect("meta lock");
        let file: WikiFile = Self::read_json(&self.paths.wiki)?;
        Ok(file
            .pages
            .values()
            .filter(|p| p.project_id == project_id)
            .count() as u64)
    }

    /// Persist live remaining-% samples (throttled per account).
    pub fn record_quota_snapshots(&self, rows: &[QuotaSnapshotInsert]) -> Result<usize> {
        if rows.is_empty() {
            return Ok(0);
        }
        let _g = self.lock.lock().expect("meta lock");
        let now = Utc::now();
        let now_s = now.to_rfc3339();
        let mut existing = Self::read_quota_lines(&self.paths.quota)?;

        let mut written = 0usize;
        for row in rows {
            if let Some(prev) = existing
                .iter()
                .rev()
                .find(|r| r.account_id == row.account_id)
            {
                if let Ok(prev_ts) = chrono::DateTime::parse_from_rfc3339(&prev.ts) {
                    let age = now.signed_duration_since(prev_ts.with_timezone(&Utc));
                    if age.num_seconds() < 60
                        && (prev.remaining_pct - row.remaining_pct).abs() < 1.0
                    {
                        continue;
                    }
                }
            }
            existing.push(QuotaSnapshotRow {
                ts: now_s.clone(),
                account_id: row.account_id.clone(),
                provider: row.provider.clone(),
                remaining_pct: row.remaining_pct,
                reset_at: row.reset_at.clone(),
            });
            written += 1;
        }

        let cutoff = now - chrono::Duration::days(7);
        existing.retain(|r| {
            chrono::DateTime::parse_from_rfc3339(&r.ts)
                .map(|t| t.with_timezone(&Utc) >= cutoff)
                .unwrap_or(true)
        });
        Self::write_quota_lines(&self.paths.quota, &existing)?;
        Ok(written)
    }

    pub fn quota_history_since(&self, since_rfc3339: &str) -> Result<Vec<QuotaSnapshotRow>> {
        let _g = self.lock.lock().expect("meta lock");
        let rows = Self::read_quota_lines(&self.paths.quota)?;
        Ok(rows
            .into_iter()
            .filter(|r| r.ts.as_str() >= since_rfc3339)
            .collect())
    }

    fn read_quota_lines(path: &Path) -> Result<Vec<QuotaSnapshotRow>> {
        if !path.exists() {
            return Ok(Vec::new());
        }
        let raw = fs::read_to_string(path)?;
        let mut out = Vec::new();
        for line in raw.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            if let Ok(row) = serde_json::from_str::<QuotaSnapshotRow>(line) {
                out.push(row);
            }
        }
        Ok(out)
    }

    fn write_quota_lines(path: &Path, rows: &[QuotaSnapshotRow]) -> Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let tmp = path.with_extension("tmp");
        {
            let mut f = fs::File::create(&tmp)?;
            for row in rows {
                writeln!(f, "{}", serde_json::to_string(row)?)?;
            }
            f.sync_all()?;
        }
        fs::rename(&tmp, path)?;
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct QuotaSnapshotInsert {
    pub account_id: String,
    pub provider: String,
    pub remaining_pct: f64,
    pub reset_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuotaSnapshotRow {
    pub ts: String,
    pub account_id: String,
    pub provider: String,
    pub remaining_pct: f64,
    pub reset_at: Option<String>,
}
