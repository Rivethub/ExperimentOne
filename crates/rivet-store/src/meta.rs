//! Local meta store — jobs, wiki index, topics, summaries, enrichments, quota.
//! Job cursors, wiki index, topics, summaries, and related meta live here.
//! Embeddings live in `ClickHouse`.
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

/// Who placed a session into this topic.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum PlacementBy {
    #[default]
    Heuristic,
    Categorizer,
    You,
}

/// Durable topic index entry. Curated fields survive worker regenerations.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TopicMeta {
    pub slug: String,
    pub title: String,
    #[serde(default)]
    pub project_id: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    /// Event ids cited as evidence (newest first, capped by the worker).
    #[serde(default)]
    pub event_ids: Vec<String>,
    /// Session ids that contributed to this topic.
    #[serde(default)]
    pub session_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// When true, worker refreshes citations but keeps title/summary/aliases/tags.
    #[serde(default)]
    pub curated: bool,
    /// Placement provenance — categorizer never overrides `You`.
    #[serde(default)]
    pub placement_by: PlacementBy,
    /// Durable decision lines for this topic (newest last).
    #[serde(default)]
    pub decisions: Vec<String>,
    /// Short startup context injected into new sessions on this topic.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub startup_context: Option<String>,
    /// `work` (default) | `entity` | `type`
    #[serde(default = "default_topic_kind")]
    pub kind: String,
    /// Parent topic slug for nested trees (≤4 levels).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_slug: Option<String>,
    pub updated_at: String,
}

fn default_topic_kind() -> String {
    "work".into()
}

/// Maximum nesting depth for topic trees (root = 1).
pub const MAX_TOPIC_DEPTH: usize = 4;

/// Depth of `slug` in the parent chain (root topics are depth 1). Cycles → 1.
#[must_use]
pub fn topic_depth(topics: &[TopicMeta], slug: &str) -> usize {
    let by_slug: BTreeMap<&str, &TopicMeta> = topics.iter().map(|t| (t.slug.as_str(), t)).collect();
    let mut depth = 1usize;
    let mut cursor = slug;
    let mut seen = std::collections::HashSet::new();
    seen.insert(cursor.to_string());
    while let Some(parent) = by_slug.get(cursor).and_then(|t| t.parent_slug.as_deref()) {
        if !seen.insert(parent.to_string()) {
            break;
        }
        depth += 1;
        if depth > MAX_TOPIC_DEPTH + 2 {
            break;
        }
        cursor = parent;
    }
    depth.min(MAX_TOPIC_DEPTH + 2)
}

/// Whether nesting a new child under `parent_slug` would stay within `MAX_TOPIC_DEPTH`.
#[must_use]
pub fn can_nest_under(topics: &[TopicMeta], parent_slug: &str) -> bool {
    topic_depth(topics, parent_slug) < MAX_TOPIC_DEPTH
}

/// Suggested `key:value` tag awaiting review.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TagSuggestion {
    pub id: String,
    pub session_id: String,
    pub tag: String,
    /// `suggested` | `accepted` | `rejected`
    #[serde(default = "default_suggested")]
    pub status: String,
    pub created_at: String,
}

fn default_suggested() -> String {
    "suggested".into()
}

/// Human-gated tidy proposal (merge/move/rename/…).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TidyProposal {
    pub id: String,
    /// `merge` | `move` | `rename` | `close` | `delete` | `create` | `type`
    pub action: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_slug: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to_slug: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub reason: String,
    /// `pending` | `approved` | `rejected`
    #[serde(default = "default_pending")]
    pub status: String,
    pub created_at: String,
}

fn default_pending() -> String {
    "pending".into()
}

/// Summary node kind in the leaf → branch → root DAG.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SummaryKind {
    #[default]
    Leaf,
    Branch,
    Root,
}

impl SummaryKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Leaf => "leaf",
            Self::Branch => "branch",
            Self::Root => "root",
        }
    }
}

/// Compaction summary for one conversation / session (DAG-capable).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SummaryMeta {
    pub id: String,
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub event_ids: Vec<String>,
    #[serde(default)]
    pub message_count: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// `leaf` | `branch` | `root`.
    #[serde(default)]
    pub kind: SummaryKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    /// Child summary ids rolled into this node (branch/root).
    #[serde(default)]
    pub source_summary_ids: Vec<String>,
    /// Depth in the DAG (leaf=0, branch=1, root=2).
    #[serde(default)]
    pub depth: u8,
    /// Compaction pipeline stamp — bump `COMPACT_PIPELINE_VERSION` to force re-mine.
    #[serde(default)]
    pub pipeline_version: u16,
    pub updated_at: String,
}

/// Current compaction pipeline version (stamp on every new/updated summary).
pub const COMPACT_PIPELINE_VERSION: u16 = 2;

/// Result of walking a summary DAG hit into child summaries + source events.
#[derive(Debug, Clone, Default)]
pub struct LineageExpand {
    pub summary_ids: Vec<String>,
    pub event_ids: Vec<String>,
}

/// Worker-side enrichment (e.g. tool-synth) attached to a session — not harness ingress.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnrichmentEvent {
    pub id: String,
    pub session_id: String,
    /// `thinking` | `tool_start` | `tool_end` | `plan` | `note`
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    pub ts: String,
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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct TopicsFile {
    #[serde(default)]
    by_slug: BTreeMap<String, TopicMeta>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct SummariesFile {
    #[serde(default)]
    by_id: BTreeMap<String, SummaryMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionBinding {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct SessionBindingsFile {
    #[serde(default)]
    by_session: BTreeMap<String, SessionBinding>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct TidyFile {
    #[serde(default)]
    proposals: Vec<TidyProposal>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct TagsFile {
    #[serde(default)]
    suggestions: Vec<TagSuggestion>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct AccessFile {
    /// `event_id` → access count (search reinforcement).
    #[serde(default)]
    by_event: BTreeMap<String, u32>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct SoftWireFile {
    /// soft: fingerprint → hard session id.
    #[serde(default)]
    soft_to_wire: BTreeMap<String, String>,
}

#[derive(Debug)]
struct MetaPaths {
    jobs: PathBuf,
    wiki: PathBuf,
    topics: PathBuf,
    summaries: PathBuf,
    enrichments: PathBuf,
    quota: PathBuf,
    sessions: PathBuf,
    tidy: PathBuf,
    tags: PathBuf,
    access: PathBuf,
    soft_wire: PathBuf,
}

#[derive(Debug)]
pub struct MetaStore {
    paths: MetaPaths,
    lock: Mutex<()>,
}

impl MetaStore {
    pub fn open(paths: &RivetPaths) -> Result<Self> {
        let dir = paths.meta_dir();
        fs::create_dir_all(dir.as_std_path())?;
        Ok(Self {
            paths: MetaPaths {
                jobs: dir.join("jobs.json").into_std_path_buf(),
                wiki: dir.join("wiki_pages.json").into_std_path_buf(),
                topics: dir.join("topics.json").into_std_path_buf(),
                summaries: dir.join("summaries.json").into_std_path_buf(),
                enrichments: dir.join("enrichments.jsonl").into_std_path_buf(),
                quota: dir.join("quota_snapshots.jsonl").into_std_path_buf(),
                sessions: dir.join("session_projects.json").into_std_path_buf(),
                tidy: dir.join("tidy_proposals.json").into_std_path_buf(),
                tags: dir.join("tag_suggestions.json").into_std_path_buf(),
                access: dir.join("access_counts.json").into_std_path_buf(),
                soft_wire: dir.join("soft_wire.json").into_std_path_buf(),
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

    /// Upsert a harness-plugin session → project/cwd binding.
    pub fn upsert_session_binding(&self, binding: SessionBinding) -> Result<SessionBinding> {
        let _g = self.lock.lock().expect("meta lock");
        let mut file: SessionBindingsFile = Self::read_json(&self.paths.sessions)?;
        let session_id = binding.session_id.trim().to_string();
        if session_id.is_empty() {
            anyhow::bail!("session_id required");
        }
        let mut next = binding;
        next.session_id.clone_from(&session_id);
        if let Some(prev) = file.by_session.get(&session_id) {
            if next.project_id.is_none() {
                next.project_id.clone_from(&prev.project_id);
            }
            if next.cwd.is_none() {
                next.cwd.clone_from(&prev.cwd);
            }
            if next.provider.is_none() {
                next.provider.clone_from(&prev.provider);
            }
            if next.source.is_none() {
                next.source.clone_from(&prev.source);
            }
        }
        file.by_session.insert(session_id, next.clone());
        Self::write_json_atomic(&self.paths.sessions, &file)?;
        Ok(next)
    }

    pub fn get_session_binding(&self, session_id: &str) -> Result<Option<SessionBinding>> {
        let id = session_id.trim();
        if id.is_empty() {
            return Ok(None);
        }
        let _g = self.lock.lock().expect("meta lock");
        let file: SessionBindingsFile = Self::read_json(&self.paths.sessions)?;
        Ok(file.by_session.get(id).cloned())
    }

    pub fn delete_session_binding(&self, session_id: &str) -> Result<bool> {
        let id = session_id.trim();
        if id.is_empty() {
            anyhow::bail!("session_id required");
        }
        let _g = self.lock.lock().expect("meta lock");
        let mut file: SessionBindingsFile = Self::read_json(&self.paths.sessions)?;
        let removed = file.by_session.remove(id).is_some();
        if removed {
            Self::write_json_atomic(&self.paths.sessions, &file)?;
        }
        Ok(removed)
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
        let mut out: Vec<_> =
            file.pages.values().filter(|p| p.project_id == project_id).cloned().collect();
        out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(out)
    }

    pub fn list_all_wiki_pages(&self) -> Result<Vec<WikiPageMeta>> {
        let _g = self.lock.lock().expect("meta lock");
        let file: WikiFile = Self::read_json(&self.paths.wiki)?;
        let mut out: Vec<_> = file.pages.values().cloned().collect();
        out.sort_by(|a, b| a.project_id.cmp(&b.project_id).then_with(|| a.path.cmp(&b.path)));
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

    pub fn wiki_page_count(&self, project_id: &str) -> Result<u64> {
        let _g = self.lock.lock().expect("meta lock");
        let file: WikiFile = Self::read_json(&self.paths.wiki)?;
        Ok(file.pages.values().filter(|p| p.project_id == project_id).count() as u64)
    }

    /// Upsert a topic. Curated topics keep title/summary/aliases/tags from disk.
    pub fn upsert_topic(&self, topic: &TopicMeta) -> Result<TopicMeta> {
        let _g = self.lock.lock().expect("meta lock");
        let mut file: TopicsFile = Self::read_json(&self.paths.topics)?;
        let slug = topic.slug.trim().to_string();
        if slug.is_empty() {
            anyhow::bail!("topic slug required");
        }
        let mut next = topic.clone();
        next.slug.clone_from(&slug);
        if let Some(prev) = file.by_slug.get(&slug) {
            if prev.curated || prev.placement_by == PlacementBy::You {
                next.title.clone_from(&prev.title);
                next.aliases.clone_from(&prev.aliases);
                next.tags.clone_from(&prev.tags);
                next.summary.clone_from(&prev.summary);
                next.decisions.clone_from(&prev.decisions);
                next.startup_context.clone_from(&prev.startup_context);
                next.placement_by = PlacementBy::You;
                next.curated = true;
            }
        }
        file.by_slug.insert(slug, next.clone());
        Self::write_json_atomic(&self.paths.topics, &file)?;
        Ok(next)
    }

    pub fn get_topic(&self, slug: &str) -> Result<Option<TopicMeta>> {
        let id = slug.trim();
        if id.is_empty() {
            return Ok(None);
        }
        let _g = self.lock.lock().expect("meta lock");
        let file: TopicsFile = Self::read_json(&self.paths.topics)?;
        Ok(file.by_slug.get(id).cloned())
    }

    pub fn list_topics(&self) -> Result<Vec<TopicMeta>> {
        let _g = self.lock.lock().expect("meta lock");
        let file: TopicsFile = Self::read_json(&self.paths.topics)?;
        let mut out: Vec<_> = file.by_slug.into_values().collect();
        out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then(a.slug.cmp(&b.slug)));
        Ok(out)
    }

    pub fn search_topics(&self, query: &str, limit: usize) -> Result<Vec<TopicMeta>> {
        let q = query.trim().to_ascii_lowercase();
        let all = self.list_topics()?;
        if q.is_empty() {
            return Ok(all.into_iter().take(limit.max(1)).collect());
        }
        Ok(all
            .into_iter()
            .filter(|t| {
                t.slug.to_ascii_lowercase().contains(&q)
                    || t.title.to_ascii_lowercase().contains(&q)
                    || t.aliases.iter().any(|a| a.to_ascii_lowercase().contains(&q))
                    || t.tags.iter().any(|a| a.to_ascii_lowercase().contains(&q))
                    || t.summary.as_ref().is_some_and(|s| s.to_ascii_lowercase().contains(&q))
            })
            .take(limit.max(1))
            .collect())
    }

    pub fn mark_topic_curated(
        &self,
        slug: &str,
        title: Option<String>,
        summary: Option<String>,
        aliases: Option<Vec<String>>,
        tags: Option<Vec<String>>,
    ) -> Result<Option<TopicMeta>> {
        let _g = self.lock.lock().expect("meta lock");
        let mut file: TopicsFile = Self::read_json(&self.paths.topics)?;
        let Some(prev) = file.by_slug.get_mut(slug.trim()) else {
            return Ok(None);
        };
        prev.curated = true;
        prev.placement_by = PlacementBy::You;
        if let Some(t) = title {
            if !t.trim().is_empty() {
                prev.title = t;
            }
        }
        if let Some(s) = summary {
            prev.summary = if s.trim().is_empty() { None } else { Some(s) };
        }
        if let Some(a) = aliases {
            prev.aliases = a;
        }
        if let Some(t) = tags {
            prev.tags = t;
        }
        prev.updated_at = Utc::now().to_rfc3339();
        let out = prev.clone();
        Self::write_json_atomic(&self.paths.topics, &file)?;
        Ok(Some(out))
    }

    pub fn upsert_summary(&self, summary: &SummaryMeta) -> Result<()> {
        let _g = self.lock.lock().expect("meta lock");
        let mut file: SummariesFile = Self::read_json(&self.paths.summaries)?;
        file.by_id.insert(summary.id.clone(), summary.clone());
        Self::write_json_atomic(&self.paths.summaries, &file)
    }

    pub fn get_summary(&self, id: &str) -> Result<Option<SummaryMeta>> {
        let _g = self.lock.lock().expect("meta lock");
        let file: SummariesFile = Self::read_json(&self.paths.summaries)?;
        Ok(file.by_id.get(id.trim()).cloned())
    }

    pub fn get_summary_for_session(&self, session_id: &str) -> Result<Option<SummaryMeta>> {
        let sid = session_id.trim();
        if sid.is_empty() {
            return Ok(None);
        }
        let mut rows = self.list_summaries_for_session(sid)?;
        // Prefer root, then branch, then leaf — best overview for browse.
        rows.sort_by_key(|s| match s.kind {
            SummaryKind::Root => 0u8,
            SummaryKind::Branch => 1,
            SummaryKind::Leaf => 2,
        });
        Ok(rows.into_iter().next())
    }

    pub fn list_summaries_for_session(&self, session_id: &str) -> Result<Vec<SummaryMeta>> {
        let sid = session_id.trim();
        if sid.is_empty() {
            return Ok(Vec::new());
        }
        let _g = self.lock.lock().expect("meta lock");
        let file: SummariesFile = Self::read_json(&self.paths.summaries)?;
        let mut out: Vec<_> = file.by_id.into_values().filter(|s| s.session_id == sid).collect();
        out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(out)
    }

    pub fn list_summaries(&self) -> Result<Vec<SummaryMeta>> {
        let _g = self.lock.lock().expect("meta lock");
        let file: SummariesFile = Self::read_json(&self.paths.summaries)?;
        let mut out: Vec<_> = file.by_id.into_values().collect();
        out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(out)
    }

    /// Event ids already covered by leaf summaries for a session.
    pub fn covered_event_ids(
        &self,
        session_id: &str,
    ) -> Result<std::collections::BTreeSet<String>> {
        let mut out = std::collections::BTreeSet::new();
        for summary in self.list_summaries_for_session(session_id)? {
            if matches!(summary.kind, SummaryKind::Leaf) {
                out.extend(summary.event_ids);
            }
        }
        Ok(out)
    }

    /// True when any summary for the session is on an older compaction pipeline.
    pub fn session_needs_pipeline_refresh(&self, session_id: &str) -> Result<bool> {
        Ok(self
            .list_summaries_for_session(session_id)?
            .into_iter()
            .any(|s| s.pipeline_version < COMPACT_PIPELINE_VERSION))
    }

    /// Walk `source_summary_ids` from a summary hit and collect descendant event ids.
    pub fn expand_summary_lineage(
        &self,
        summary_id: &str,
        max_events: usize,
        max_depth: u8,
    ) -> Result<LineageExpand> {
        let mut out = LineageExpand::default();
        let mut seen_summaries = std::collections::BTreeSet::new();
        let mut seen_events = std::collections::BTreeSet::new();
        let mut stack = vec![(summary_id.trim().to_string(), 0u8)];
        while let Some((id, depth)) = stack.pop() {
            if id.is_empty() || !seen_summaries.insert(id.clone()) {
                continue;
            }
            out.summary_ids.push(id.clone());
            let Some(summary) = self.get_summary(&id)? else {
                continue;
            };
            for eid in &summary.event_ids {
                if seen_events.insert(eid.clone()) {
                    out.event_ids.push(eid.clone());
                    if out.event_ids.len() >= max_events {
                        return Ok(out);
                    }
                }
            }
            if depth >= max_depth {
                continue;
            }
            for child in summary.source_summary_ids.iter().rev() {
                stack.push((child.clone(), depth + 1));
            }
        }
        Ok(out)
    }

    /// For fused traffic hits: expand via covering summaries' DAG (siblings + children).
    pub fn expand_events_via_lineage(
        &self,
        event_ids: &[String],
        max_extra: usize,
    ) -> Result<Vec<String>> {
        if event_ids.is_empty() || max_extra == 0 {
            return Ok(Vec::new());
        }
        let seed: std::collections::BTreeSet<&str> = event_ids.iter().map(String::as_str).collect();
        let mut extra = Vec::new();
        let mut visited: std::collections::BTreeSet<String> = event_ids.iter().cloned().collect();
        let summaries = self.list_summaries()?;
        for summary in &summaries {
            let covers = summary.event_ids.iter().any(|id| seed.contains(id.as_str()));
            if !covers {
                continue;
            }
            let expanded = self.expand_summary_lineage(&summary.id, max_extra * 2, 4)?;
            for eid in expanded.event_ids {
                if visited.insert(eid.clone()) {
                    extra.push(eid);
                    if extra.len() >= max_extra {
                        return Ok(extra);
                    }
                }
            }
            // Sibling events on the same leaf even when DAG walk is shallow.
            for eid in &summary.event_ids {
                if visited.insert(eid.clone()) {
                    extra.push(eid.clone());
                    if extra.len() >= max_extra {
                        return Ok(extra);
                    }
                }
            }
        }
        Ok(extra)
    }

    pub fn list_tidy_proposals(&self, pending_only: bool) -> Result<Vec<TidyProposal>> {
        let _g = self.lock.lock().expect("meta lock");
        let file: TidyFile = Self::read_json(&self.paths.tidy)?;
        let mut out = file.proposals;
        if pending_only {
            out.retain(|p| p.status == "pending");
        }
        out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(out)
    }

    pub fn upsert_tidy_proposal(&self, proposal: &TidyProposal) -> Result<()> {
        let _g = self.lock.lock().expect("meta lock");
        let mut file: TidyFile = Self::read_json(&self.paths.tidy)?;
        if let Some(existing) = file.proposals.iter_mut().find(|p| p.id == proposal.id) {
            *existing = proposal.clone();
        } else {
            file.proposals.push(proposal.clone());
        }
        Self::write_json_atomic(&self.paths.tidy, &file)
    }

    pub fn set_tidy_status(&self, id: &str, status: &str) -> Result<Option<TidyProposal>> {
        let _g = self.lock.lock().expect("meta lock");
        let mut file: TidyFile = Self::read_json(&self.paths.tidy)?;
        let Some(row) = file.proposals.iter_mut().find(|p| p.id == id.trim()) else {
            return Ok(None);
        };
        row.status = status.to_string();
        let out = row.clone();
        Self::write_json_atomic(&self.paths.tidy, &file)?;
        Ok(Some(out))
    }

    /// Apply an approved tidy proposal to the topic tree (best-effort).
    pub fn apply_tidy_proposal(&self, id: &str) -> Result<Option<TidyProposal>> {
        let proposal = {
            let _g = self.lock.lock().expect("meta lock");
            let file: TidyFile = Self::read_json(&self.paths.tidy)?;
            file.proposals.into_iter().find(|p| p.id == id.trim())
        };
        let Some(proposal) = proposal else {
            return Ok(None);
        };
        match proposal.action.as_str() {
            "rename" => {
                if let (Some(slug), Some(title)) =
                    (proposal.from_slug.as_deref(), proposal.title.as_deref())
                {
                    let mut topics = self.list_topics()?;
                    if let Some(topic) = topics.iter_mut().find(|t| t.slug == slug) {
                        topic.title = title.to_string();
                        topic.placement_by = PlacementBy::You;
                        topic.curated = true;
                        topic.updated_at = Utc::now().to_rfc3339();
                        let _ = self.upsert_topic(topic);
                    }
                }
            },
            "merge" => {
                if let (Some(from), Some(to)) =
                    (proposal.from_slug.as_deref(), proposal.to_slug.as_deref())
                {
                    let from_topic = self.get_topic(from)?;
                    let to_topic = self.get_topic(to)?;
                    if let (Some(from_t), Some(mut to_t)) = (from_topic, to_topic) {
                        for sid in from_t.session_ids {
                            if !to_t.session_ids.contains(&sid) {
                                to_t.session_ids.push(sid);
                            }
                        }
                        for eid in from_t.event_ids {
                            if !to_t.event_ids.contains(&eid) {
                                to_t.event_ids.push(eid);
                            }
                        }
                        to_t.updated_at = Utc::now().to_rfc3339();
                        let _ = self.upsert_topic(&to_t);
                        let _ = self.delete_topic(from);
                    }
                }
            },
            "move" => {
                if let (Some(from), Some(under)) =
                    (proposal.from_slug.as_deref(), proposal.to_slug.as_deref())
                {
                    let topics = self.list_topics()?;
                    if !can_nest_under(&topics, under) {
                        // Depth would exceed cap — reject silently (stay pending→approved no-op).
                    } else if let Some(mut topic) = self.get_topic(from)? {
                        topic.parent_slug = Some(under.to_string());
                        topic.updated_at = Utc::now().to_rfc3339();
                        let _ = self.upsert_topic(&topic);
                    }
                }
            },
            "delete" | "close" => {
                if let Some(slug) = proposal.from_slug.as_deref() {
                    let _ = self.delete_topic(slug);
                }
            },
            "create" => {
                if let Some(title) = proposal.title.as_deref() {
                    let slug = title
                        .trim()
                        .to_ascii_lowercase()
                        .chars()
                        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
                        .collect::<String>()
                        .trim_matches('-')
                        .to_string();
                    let slug = if slug.is_empty() {
                        format!("topic-{}", Utc::now().timestamp())
                    } else {
                        slug
                    };
                    // `to_slug` on create means optional parent (`under`).
                    let parent = proposal
                        .to_slug
                        .as_deref()
                        .map(str::trim)
                        .filter(|s| !s.is_empty() && *s != slug)
                        .map(str::to_string);
                    let topics = self.list_topics()?;
                    let parent = parent.filter(|p| can_nest_under(&topics, p));
                    let topic = TopicMeta {
                        slug,
                        title: title.to_string(),
                        project_id: String::new(),
                        aliases: Vec::new(),
                        tags: Vec::new(),
                        event_ids: Vec::new(),
                        session_ids: Vec::new(),
                        summary: None,
                        curated: true,
                        placement_by: PlacementBy::You,
                        decisions: Vec::new(),
                        startup_context: None,
                        kind: "work".into(),
                        parent_slug: parent,
                        updated_at: Utc::now().to_rfc3339(),
                    };
                    let _ = self.upsert_topic(&topic);
                }
            },
            _ => {},
        }
        self.set_tidy_status(id, "approved")
    }

    pub fn delete_topic(&self, slug: &str) -> Result<bool> {
        let _g = self.lock.lock().expect("meta lock");
        let mut file: TopicsFile = Self::read_json(&self.paths.topics)?;
        let removed = file.by_slug.remove(slug.trim()).is_some();
        if removed {
            Self::write_json_atomic(&self.paths.topics, &file)?;
        }
        Ok(removed)
    }

    pub fn append_decision(&self, slug: &str, decision: &str) -> Result<Option<TopicMeta>> {
        let decision = decision.trim();
        if decision.is_empty() {
            return Ok(None);
        }
        let Some(mut topic) = self.get_topic(slug)? else {
            return Ok(None);
        };
        topic.decisions.push(decision.to_string());
        if topic.decisions.len() > 40 {
            let drain = topic.decisions.len() - 40;
            topic.decisions.drain(..drain);
        }
        topic.updated_at = Utc::now().to_rfc3339();
        Ok(Some(self.upsert_topic(&topic)?))
    }

    pub fn set_startup_context(&self, slug: &str, context: &str) -> Result<Option<TopicMeta>> {
        let Some(mut topic) = self.get_topic(slug)? else {
            return Ok(None);
        };
        topic.startup_context = Some(context.trim().to_string());
        topic.updated_at = Utc::now().to_rfc3339();
        Ok(Some(self.upsert_topic(&topic)?))
    }

    pub fn bump_access(&self, event_id: &str) -> Result<u32> {
        let _g = self.lock.lock().expect("meta lock");
        let mut file: AccessFile = Self::read_json(&self.paths.access)?;
        let entry = file.by_event.entry(event_id.trim().to_string()).or_insert(0);
        *entry = entry.saturating_add(1);
        let n = *entry;
        Self::write_json_atomic(&self.paths.access, &file)?;
        Ok(n)
    }

    pub fn access_count(&self, event_id: &str) -> Result<u32> {
        let _g = self.lock.lock().expect("meta lock");
        let file: AccessFile = Self::read_json(&self.paths.access)?;
        Ok(file.by_event.get(event_id.trim()).copied().unwrap_or(0))
    }

    pub fn access_counts_for(&self, ids: &[String]) -> Result<BTreeMap<String, u32>> {
        let _g = self.lock.lock().expect("meta lock");
        let file: AccessFile = Self::read_json(&self.paths.access)?;
        let mut out = BTreeMap::new();
        for id in ids {
            if let Some(n) = file.by_event.get(id) {
                out.insert(id.clone(), *n);
            }
        }
        Ok(out)
    }

    /// Record that a soft fingerprint now maps to a hard session id.
    pub fn record_soft_wire(&self, soft: &str, hard: &str) -> Result<()> {
        let soft = soft.trim();
        let hard = hard.trim();
        if !soft.starts_with("soft:") || hard.is_empty() || hard.starts_with("soft:") {
            return Ok(());
        }
        let _g = self.lock.lock().expect("meta lock");
        let mut file: SoftWireFile = Self::read_json(&self.paths.soft_wire)?;
        file.soft_to_wire.insert(soft.to_string(), hard.to_string());
        Self::write_json_atomic(&self.paths.soft_wire, &file)
    }

    pub fn resolve_soft_wire(&self, soft: &str) -> Result<Option<String>> {
        let _g = self.lock.lock().expect("meta lock");
        let file: SoftWireFile = Self::read_json(&self.paths.soft_wire)?;
        Ok(file.soft_to_wire.get(soft.trim()).cloned())
    }

    /// Soft fingerprints that resolve to this hard session (for conversation merge).
    pub fn soft_aliases_for_wire(&self, hard: &str) -> Result<Vec<String>> {
        let hard = hard.trim();
        let _g = self.lock.lock().expect("meta lock");
        let file: SoftWireFile = Self::read_json(&self.paths.soft_wire)?;
        Ok(file
            .soft_to_wire
            .iter()
            .filter(|(_, w)| w.as_str() == hard)
            .map(|(s, _)| s.clone())
            .collect())
    }

    pub fn upsert_tag_suggestion(&self, suggestion: &TagSuggestion) -> Result<()> {
        let _g = self.lock.lock().expect("meta lock");
        let mut file: TagsFile = Self::read_json(&self.paths.tags)?;
        if let Some(existing) = file.suggestions.iter_mut().find(|s| s.id == suggestion.id) {
            *existing = suggestion.clone();
        } else {
            file.suggestions.push(suggestion.clone());
        }
        Self::write_json_atomic(&self.paths.tags, &file)
    }

    pub fn list_tag_suggestions(&self, pending_only: bool) -> Result<Vec<TagSuggestion>> {
        let _g = self.lock.lock().expect("meta lock");
        let file: TagsFile = Self::read_json(&self.paths.tags)?;
        let mut out = file.suggestions;
        if pending_only {
            out.retain(|s| s.status == "suggested");
        }
        out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(out)
    }

    pub fn set_tag_status(&self, id: &str, status: &str) -> Result<Option<TagSuggestion>> {
        let _g = self.lock.lock().expect("meta lock");
        let mut file: TagsFile = Self::read_json(&self.paths.tags)?;
        let Some(row) = file.suggestions.iter_mut().find(|s| s.id == id.trim()) else {
            return Ok(None);
        };
        row.status = status.to_string();
        let out = row.clone();
        Self::write_json_atomic(&self.paths.tags, &file)?;
        Ok(Some(out))
    }

    pub fn append_enrichment(&self, event: &EnrichmentEvent) -> Result<()> {
        let _g = self.lock.lock().expect("meta lock");
        if let Some(parent) = self.paths.enrichments.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut f =
            fs::OpenOptions::new().create(true).append(true).open(&self.paths.enrichments)?;
        writeln!(f, "{}", serde_json::to_string(event)?)?;
        f.sync_all()?;
        Ok(())
    }

    pub fn list_enrichments(&self, session_id: &str, limit: usize) -> Result<Vec<EnrichmentEvent>> {
        let sid = session_id.trim();
        if sid.is_empty() {
            return Ok(Vec::new());
        }
        let _g = self.lock.lock().expect("meta lock");
        if !self.paths.enrichments.exists() {
            return Ok(Vec::new());
        }
        let raw = fs::read_to_string(&self.paths.enrichments)?;
        let mut out = Vec::new();
        for line in raw.lines().rev() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let Ok(ev) = serde_json::from_str::<EnrichmentEvent>(line) else {
                continue;
            };
            if ev.session_id == sid {
                out.push(ev);
                if out.len() >= limit.max(1) {
                    break;
                }
            }
        }
        out.reverse();
        Ok(out)
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
            if let Some(prev) = existing.iter().rev().find(|r| r.account_id == row.account_id) {
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
                .map_or(true, |t| t.with_timezone(&Utc) >= cutoff)
        });
        Self::write_quota_lines(&self.paths.quota, &existing)?;
        Ok(written)
    }

    pub fn quota_history_since(&self, since_rfc3339: &str) -> Result<Vec<QuotaSnapshotRow>> {
        let _g = self.lock.lock().expect("meta lock");
        let rows = Self::read_quota_lines(&self.paths.quota)?;
        Ok(rows.into_iter().filter(|r| r.ts.as_str() >= since_rfc3339).collect())
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

#[cfg(test)]
mod topic_depth_tests {
    use super::*;

    fn topic(slug: &str, parent: Option<&str>) -> TopicMeta {
        TopicMeta {
            slug: slug.into(),
            title: slug.into(),
            project_id: String::new(),
            aliases: Vec::new(),
            tags: Vec::new(),
            event_ids: Vec::new(),
            session_ids: Vec::new(),
            summary: None,
            curated: false,
            placement_by: PlacementBy::Heuristic,
            decisions: Vec::new(),
            startup_context: None,
            kind: "work".into(),
            parent_slug: parent.map(str::to_string),
            updated_at: Utc::now().to_rfc3339(),
        }
    }

    #[test]
    fn depth_counts_ancestors() {
        let topics = vec![
            topic("root", None),
            topic("a", Some("root")),
            topic("b", Some("a")),
            topic("c", Some("b")),
        ];
        assert_eq!(topic_depth(&topics, "root"), 1);
        assert_eq!(topic_depth(&topics, "a"), 2);
        assert_eq!(topic_depth(&topics, "c"), 4);
        assert!(can_nest_under(&topics, "b"));
        assert!(!can_nest_under(&topics, "c"));
    }
}
