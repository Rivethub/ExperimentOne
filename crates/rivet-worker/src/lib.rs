//! Background workers for vectorize, wiki, topics, project backfill, compaction.
//!
//! Ingest captures signals (`cwd`, bodies) and hard-evidence `project_id` only
//! (explicit fields / harness project keys). Workers classify when evidence was
//! missing — never promote cwd alone to a project at capture time.
//!
//! - **Vectorize**: embeds capture content as local lexical 64-d vectors into
//!   `ClickHouse` HNSW (`LEXICAL_SPACE`).
//! - **Wiki**: capture markdown tree + knowledge extract (patch → bound →
//!   archive → consolidate/recompile) when `wiki_model` is set.
//! - **Topics**: durable keyword topics with event/session citations in meta.
//! - **Classify**: backfill session→project bindings from cwd when missing.
//! - **Compact**: conversation summaries under meta + wiki/summaries.
//! - **Wiki FS sync**: watches `wiki/` and keeps file meta aligned with disk.
//!
//! Role isolation via `RIVET_WORKER_ROLE=all|embed|compact|wiki|none`.

mod prompts;
mod wiki_fs;
mod wiki_page;
mod wiki_schema;

use std::collections::{BTreeMap, HashMap};
use std::fmt::Write as _;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use chrono::Utc;
use rivet_core::{
    chunk_text, hydrate_events, lexical_embed, looks_unembeddable, normalize_event_turns,
    project_id_from_cwd, LiveBus, LiveEvent, RivetConfig, RivetPaths, CaptureEvent, CaptureRole,
    TurnKind, LEXICAL_SPACE,
};
use rivet_store::{
    ClaimedJob, ClickHouseCaptureStore, MetaStore, NatsJobStore, PlacementBy, SessionBinding,
    SummaryKind, SummaryMeta, TidyProposal, TopicMeta, CaptureStore, WikiPageMeta, WorkerJob,
    WorkerRole, COMPACT_PIPELINE_VERSION, PRIORITY_BACKFILL, PRIORITY_CLASSIFY,
    PRIORITY_LIVE_COMPACT, PRIORITY_WIKI, TASK_CLASSIFY_SESSION, TASK_COMPACT_SESSION,
    TASK_CONSOLIDATE_WIKI, TASK_EMBED_EVENT, TASK_ENQUEUE_IDLE, TASK_ENQUEUE_UNEMBEDDED,
    TASK_ENQUEUE_WIKI_BACKFILL, TASK_EXTRACT_WIKI, TASK_RECOMPILE_WIKI, TASK_SUGGEST_TAGS,
    TASK_SYNTHESIZE_TOOL, TASK_UPSERT_TOPICS,
};
use serde_json::{json, Value};
use tokio::sync::RwLock;
use tracing::{debug, info, warn};

pub use wiki_fs::{reconcile_wiki_dir, spawn_wiki_watcher};

pub struct WorkerPool {
    store: Arc<dyn CaptureStore>,
    ch: Arc<ClickHouseCaptureStore>,
    jobs: Arc<NatsJobStore>,
    meta: Arc<MetaStore>,
    paths: RivetPaths,
    config: Arc<RwLock<RivetConfig>>,
    http: reqwest::Client,
    wiki_revision: Arc<AtomicU64>,
    live: LiveBus,
}

impl std::fmt::Debug for WorkerPool {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WorkerPool").field("paths", &self.paths).finish_non_exhaustive()
    }
}

impl WorkerPool {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        store: Arc<dyn CaptureStore>,
        ch: Arc<ClickHouseCaptureStore>,
        jobs: Arc<NatsJobStore>,
        meta: Arc<MetaStore>,
        paths: RivetPaths,
        config: Arc<RwLock<RivetConfig>>,
        wiki_revision: Arc<AtomicU64>,
        live: LiveBus,
    ) -> Self {
        Self {
            store,
            ch,
            jobs,
            meta,
            paths,
            config,
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(60))
                .build()
                .expect("reqwest client"),
            wiki_revision,
            live,
        }
    }

    fn bump_wiki_revision(&self) {
        let revision = self.wiki_revision.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        self.live.publish(LiveEvent::Wiki { revision });
    }

    pub fn wiki_revision(&self) -> Arc<AtomicU64> {
        self.wiki_revision.clone()
    }

    pub fn spawn(self: Arc<Self>) -> Vec<tokio::task::JoinHandle<()>> {
        let role = WorkerRole::from_env();
        info!(role = role.as_str(), "starting NATS job workers");
        let watcher = spawn_wiki_watcher(
            self.paths.clone(),
            self.meta.clone(),
            self.wiki_revision.clone(),
            self.live.clone(),
        );
        let mut handles = vec![watcher];
        if role == WorkerRole::None {
            return handles;
        }
        let roles: Vec<WorkerRole> = match role {
            WorkerRole::All => {
                vec![WorkerRole::Embed, WorkerRole::Compact, WorkerRole::Wiki]
            },
            other => vec![other],
        };
        for role in roles {
            let this = self.clone();
            handles.push(tokio::spawn(async move {
                if let Err(err) = this.run_role(role).await {
                    warn!(?err, role = role.as_str(), "worker role exited");
                }
            }));
        }
        // Cron-style backstop enqueues (does not do the work itself).
        handles.push(tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(60));
            loop {
                tick.tick().await;
                if let Err(err) = self.enqueue_backstops().await {
                    warn!(?err, "worker backstop enqueue failed");
                }
            }
        }));
        handles
    }

    /// Manual / API tick: enqueue backstops then drain a few claims per role.
    pub async fn tick_once(&self) -> Result<()> {
        if let Ok((upserts, removed)) = reconcile_wiki_dir(&self.paths, &self.meta) {
            if upserts > 0 || removed > 0 {
                self.bump_wiki_revision();
            }
        }
        self.enqueue_backstops().await?;
        for role in [WorkerRole::Embed, WorkerRole::Compact, WorkerRole::Wiki] {
            self.drain_role(role, 8).await?;
        }
        Ok(())
    }

    async fn run_role(&self, role: WorkerRole) -> Result<()> {
        let worker_id = format!("{}-{}", role.as_str(), uuid_like());
        // Immediate drain so UI fills quickly after boot.
        if let Err(err) = self.drain_role_as(&worker_id, role, 16).await {
            warn!(?err, role = role.as_str(), "initial role drain failed");
        }
        let mut tick = tokio::time::interval(Duration::from_secs(2));
        loop {
            tick.tick().await;
            if let Err(err) = self.drain_role_as(&worker_id, role, 8).await {
                warn!(?err, role = role.as_str(), "role drain failed");
            }
        }
    }

    async fn drain_role(&self, role: WorkerRole, limit: u32) -> Result<()> {
        let worker_id = format!("{}-tick", role.as_str());
        self.drain_role_as(&worker_id, role, limit).await
    }

    async fn drain_role_as(&self, worker_id: &str, role: WorkerRole, limit: u32) -> Result<()> {
        let claimed = self.jobs.claim_jobs(role, worker_id, limit).await?;
        for claimed in claimed {
            let job_key = claimed.job.job_key.clone();
            let task = claimed.job.task.clone();
            let result = self.handle_job(&claimed.job, worker_id).await;
            match result {
                Ok(()) => {
                    if let Err(err) = self.jobs.complete_job(claimed, true, None).await {
                        warn!(?err, job_key = %job_key, "failed to ack job done");
                    }
                },
                Err(err) => {
                    let msg = err.to_string();
                    warn!(error = %msg, job_key = %job_key, task = %task, "job failed");
                    if let Err(complete_err) =
                        self.jobs.complete_job(claimed, false, Some(&msg)).await
                    {
                        warn!(?complete_err, job_key = %job_key, "failed to nak job");
                    }
                },
            }
        }
        Ok(())
    }

    async fn enqueue_backstops(&self) -> Result<()> {
        let cfg = self.config.read().await.clone();
        let mut jobs = vec![
            WorkerJob::enqueue_unembedded(),
            WorkerJob::enqueue_idle(),
            WorkerJob::upsert_topics(),
        ];
        if cfg.capabilities.wiki {
            jobs.push(WorkerJob::new_pending(
                TASK_EXTRACT_WIKI,
                "extract-wiki:tick",
                "{}",
                PRIORITY_WIKI,
            ));
            jobs.push(WorkerJob::new_pending(
                TASK_ENQUEUE_WIKI_BACKFILL,
                "enqueue-wiki-backfill:tick",
                "{}",
                PRIORITY_BACKFILL,
            ));
        }
        self.jobs.enqueue_jobs(&jobs).await?;
        Ok(())
    }

    async fn handle_job(&self, job: &WorkerJob, worker_id: &str) -> Result<()> {
        let cfg = self.config.read().await.clone();
        match job.task.as_str() {
            TASK_EMBED_EVENT => {
                if !cfg.capabilities.vector_search {
                    return Ok(());
                }
                let event_id = payload_str(&job.payload, "event_id")?;
                self.embed_one_event(&event_id).await
            },
            TASK_ENQUEUE_UNEMBEDDED => {
                if !cfg.capabilities.vector_search {
                    return Ok(());
                }
                self.enqueue_missing_embeds().await
            },
            TASK_CLASSIFY_SESSION => {
                let session_id = payload_str(&job.payload, "session_id")?;
                self.classify_one_session(&session_id).await
            },
            TASK_COMPACT_SESSION => {
                let session_id = payload_str(&job.payload, "session_id")?;
                let reason =
                    payload_str_opt(&job.payload, "reason").unwrap_or_else(|| "idle".into());
                self.compact_one_session(&cfg, &session_id, &reason).await
            },
            TASK_ENQUEUE_IDLE => self.enqueue_idle_compacts().await,
            TASK_UPSERT_TOPICS => self.upsert_topics(&cfg).await,
            TASK_SYNTHESIZE_TOOL => {
                let event_id = payload_str(&job.payload, "event_id")?;
                self.synthesize_tool_event(&cfg, &event_id).await
            },
            TASK_SUGGEST_TAGS => {
                let session_id = payload_str(&job.payload, "session_id")?;
                self.file_session_topic(&cfg, &session_id).await?;
                self.suggest_session_tags(&cfg, &session_id).await
            },
            TASK_EXTRACT_WIKI => {
                if !cfg.capabilities.wiki {
                    return Ok(());
                }
                if let Some(summary_id) = payload_str_opt(&job.payload, "summary_id") {
                    let routes = payload_string_list(&job.payload, "routes");
                    self.extract_one_summary(&cfg, &summary_id, &routes, worker_id, &job.job_key)
                        .await?;
                } else {
                    self.upsert_wiki(&cfg).await?;
                    let _ = self.enqueue_pending_wiki_extracts().await;
                    let _ = self.extract_wiki_from_summaries(&cfg).await;
                }
                self.reconcile_wiki_after_write();
                Ok(())
            },
            TASK_ENQUEUE_WIKI_BACKFILL => {
                if !cfg.capabilities.wiki {
                    return Ok(());
                }
                self.enqueue_wiki_backfill().await?;
                // Project-wide identity consolidate pass (no slug → plan folds).
                if payload_str_opt(&job.payload, "slug").is_none() {
                    self.consolidate_wiki_project(&cfg);
                }
                Ok(())
            },
            TASK_CONSOLIDATE_WIKI => {
                if !cfg.capabilities.wiki {
                    return Ok(());
                }
                if let Some(slug) = payload_str_opt(&job.payload, "slug") {
                    self.consolidate_wiki_topic(&cfg, &slug)?;
                } else {
                    self.consolidate_wiki_project(&cfg);
                }
                self.reconcile_wiki_after_write();
                Ok(())
            },
            TASK_RECOMPILE_WIKI => {
                if !cfg.capabilities.wiki {
                    return Ok(());
                }
                let slug = payload_str(&job.payload, "slug")?;
                self.recompile_wiki_topic(&cfg, &slug).await?;
                self.reconcile_wiki_after_write();
                Ok(())
            },
            other => {
                debug!(task = other, "ignoring unknown job task");
                Ok(())
            },
        }
    }

    fn reconcile_wiki_after_write(&self) {
        if let Ok((upserts, removed)) = reconcile_wiki_dir(&self.paths, &self.meta) {
            if upserts > 0 || removed > 0 {
                self.bump_wiki_revision();
            }
        }
    }

    async fn embed_one_event(&self, event_id: &str) -> Result<()> {
        let existing = self.ch.embedded_event_ids(LEXICAL_SPACE).await?;
        let mut events = self.store.get_by_ids(&[event_id.to_string()]).await?;
        let Some(mut event) = events.pop() else {
            return Ok(());
        };
        hydrate_events(&self.paths, std::slice::from_mut(&mut event));
        let text = event.content.as_deref().unwrap_or("").trim();
        if text.is_empty() || looks_unembeddable(text) {
            return Ok(());
        }
        // Embed up to 3 paragraph-aware chunks as `{id}#c{n}` (search strips the suffix).
        let chunks = chunk_text(text, 2_000);
        let needed = chunks.len().min(3);
        let have_base = existing.contains(event_id);
        let have_chunks =
            (1..needed).filter(|i| existing.contains(&format!("{event_id}#c{i}"))).count();
        if have_base && have_chunks + 1 >= needed {
            return Ok(());
        }
        let mut batch = Vec::new();
        for (i, chunk) in chunks.into_iter().take(3).enumerate() {
            if chunk.trim().is_empty() {
                continue;
            }
            let key = if i == 0 { event_id.to_string() } else { format!("{event_id}#c{i}") };
            batch.push((key, lexical_embed(&chunk)));
        }
        if batch.is_empty() {
            return Ok(());
        }
        self.ch.upsert_embeddings_batch(LEXICAL_SPACE, &batch).await?;
        Ok(())
    }

    async fn enqueue_missing_embeds(&self) -> Result<()> {
        let all = self.store.export_all().await?;
        let existing = self.ch.embedded_event_ids(LEXICAL_SPACE).await?;
        let mut jobs = Vec::new();
        for event in all {
            let id = event.id.to_string();
            // Treat base id or any `{id}#cN` chunk as "has embedding".
            let has = existing.contains(&id)
                || existing.iter().any(|e| e.starts_with(&format!("{id}#c")));
            if has {
                continue;
            }
            let text = event.content.as_deref().unwrap_or("").trim();
            if text.is_empty() || looks_unembeddable(text) {
                continue;
            }
            // Re-embed when text is long enough for multi-chunk but only base id exists.
            jobs.push(WorkerJob::embed_event(&id));
            if jobs.len() >= 120 {
                break;
            }
        }
        self.jobs.enqueue_jobs(&jobs).await?;
        self.meta.set_job_cursor("vectorize", &Utc::now().to_rfc3339())?;
        Ok(())
    }

    async fn classify_one_session(&self, session_id: &str) -> Result<()> {
        if session_id.starts_with("soft:") {
            return Ok(());
        }
        let events = self.store.conversation_events(session_id, 50).await?;
        let Some(event) =
            events.iter().rev().find(|e| e.cwd.as_deref().is_some_and(|c| !c.trim().is_empty()))
        else {
            return Ok(());
        };
        let cwd = event.cwd.as_deref().unwrap_or("").trim();
        let Some(project_id) = project_id_from_cwd(cwd) else {
            return Ok(());
        };
        let existing = self.meta.get_session_binding(session_id)?;
        if existing.as_ref().and_then(|b| b.project_id.as_deref()) == Some(project_id.as_str()) {
            return Ok(());
        }
        self.meta.upsert_session_binding(SessionBinding {
            session_id: session_id.to_string(),
            project_id: Some(project_id),
            cwd: Some(cwd.to_string()),
            provider: Some(provider_key(event)),
            source: Some("worker-classify".into()),
            updated_at: Utc::now().to_rfc3339(),
        })?;
        self.meta.set_job_cursor("classify", &Utc::now().to_rfc3339())?;
        Ok(())
    }

    async fn enqueue_idle_compacts(&self) -> Result<()> {
        let recent = self.store.recent(500).await?;
        let mut by_session: BTreeMap<String, (usize, chrono::DateTime<Utc>)> = BTreeMap::new();
        for event in &recent {
            let Some(sid) = event.session_id.as_deref().map(str::trim).filter(|s| !s.is_empty())
            else {
                continue;
            };
            let entry = by_session.entry(sid.to_string()).or_insert((0, event.ts));
            entry.0 += 1;
            if event.ts > entry.1 {
                entry.1 = event.ts;
            }
        }
        let now = Utc::now();
        let mut jobs = Vec::new();
        for (session_id, (count, last_ts)) in by_session {
            if count < 2 {
                continue;
            }
            let covered = self.meta.covered_event_ids(&session_id).unwrap_or_default();
            // Approximate uncovered from recent window; compact loads the full conversation.
            let uncovered_est = count.saturating_sub(covered.len());
            let root = self.meta.get_summary_for_session(&session_id).ok().flatten();
            let has_root = root.as_ref().is_some_and(|s| matches!(s.kind, SummaryKind::Root));
            let pipeline_stale =
                self.meta.session_needs_pipeline_refresh(&session_id).unwrap_or(false);
            let root_age = root.as_ref().and_then(|s| {
                chrono::DateTime::parse_from_rfc3339(&s.updated_at)
                    .ok()
                    .map(|d| now - d.with_timezone(&Utc))
            });
            let idle = now - last_ts >= chrono::Duration::minutes(15);
            let stale_root = root_age.is_some_and(|age| age >= chrono::Duration::days(4));

            let reason = if pipeline_stale {
                Some("pipeline")
            } else if uncovered_est >= 10 {
                // Active-session threshold: enough unsummarized tail to roll a leaf.
                Some("threshold")
            } else if !has_root && idle && count >= 4 {
                Some("idle")
            } else if has_root && (stale_root || (idle && uncovered_est >= 2)) {
                Some("stale")
            } else if has_root && uncovered_est >= 4 && idle {
                Some("idle")
            } else {
                None
            };
            let Some(reason) = reason else {
                continue;
            };
            let mut job = WorkerJob::compact_session_reason(&session_id, reason);
            if now - last_ts < chrono::Duration::hours(6)
                && reason != "stale"
                && reason != "pipeline"
            {
                job.priority = PRIORITY_LIVE_COMPACT;
            } else {
                job.priority = PRIORITY_BACKFILL;
            }
            jobs.push(job);
            if jobs.len() >= 10 {
                break;
            }
        }
        self.jobs.enqueue_jobs(&jobs).await?;
        Ok(())
    }

    async fn compact_one_session(
        &self,
        cfg: &RivetConfig,
        session_id: &str,
        reason: &str,
    ) -> Result<()> {
        let mut events = self.store.conversation_events(session_id, 200).await?;
        hydrate_events(&self.paths, &mut events);
        if events.len() < 2 {
            return Ok(());
        }
        let pipeline_refresh = reason == "pipeline"
            || self.meta.session_needs_pipeline_refresh(session_id).unwrap_or(false);
        let covered = if pipeline_refresh {
            std::collections::BTreeSet::new()
        } else {
            self.meta.covered_event_ids(session_id)?
        };
        let uncovered: Vec<CaptureEvent> =
            events.iter().filter(|e| !covered.contains(&e.id.to_string())).cloned().collect();
        let has_root = self
            .meta
            .get_summary_for_session(session_id)?
            .is_some_and(|s| matches!(s.kind, SummaryKind::Root));

        // Nothing new and root is current — only stale/pipeline rebuilds the DAG top.
        if uncovered.is_empty() && has_root && !pipeline_refresh && reason != "stale" {
            return Ok(());
        }
        if uncovered.is_empty() && !has_root && events.len() < 4 {
            return Ok(());
        }

        let project_id = events.iter().find_map(|e| e.project_id.clone());
        let model = cfg.wiki_model.clone();

        let leaf_ids = if pipeline_refresh {
            self.write_leaf_summaries(
                cfg,
                session_id,
                &events,
                project_id.as_deref(),
                model.as_deref(),
                0,
                true,
            )
            .await?
        } else if !uncovered.is_empty() {
            let start_idx = self
                .meta
                .list_summaries_for_session(session_id)?
                .into_iter()
                .filter(|s| matches!(s.kind, SummaryKind::Leaf))
                .count();
            let mut ids = self
                .meta
                .list_summaries_for_session(session_id)?
                .into_iter()
                .filter(|s| matches!(s.kind, SummaryKind::Leaf))
                .map(|s| s.id)
                .collect::<Vec<_>>();
            let new_ids = self
                .write_leaf_summaries(
                    cfg,
                    session_id,
                    &uncovered,
                    project_id.as_deref(),
                    model.as_deref(),
                    start_idx,
                    false,
                )
                .await?;
            ids.extend(new_ids);
            let mut seen = std::collections::BTreeSet::new();
            ids.retain(|id| seen.insert(id.clone()));
            ids
        } else {
            self.meta
                .list_summaries_for_session(session_id)?
                .into_iter()
                .filter(|s| matches!(s.kind, SummaryKind::Leaf))
                .map(|s| s.id)
                .collect()
        };

        if leaf_ids.is_empty() {
            return Ok(());
        }

        let branch_ids = self
            .write_branch_summaries(
                cfg,
                session_id,
                &leaf_ids,
                project_id.as_deref(),
                model.as_deref(),
            )
            .await?;
        self.write_root_summary(cfg, session_id, &events, &branch_ids, project_id, model).await?;
        self.meta.set_job_cursor("compact", &Utc::now().to_rfc3339())?;
        let _ = self.refresh_topic_memory_from_root(session_id);
        self.enqueue_after_compact(cfg, session_id, events.len()).await?;
        Ok(())
    }

    async fn enqueue_after_compact(
        &self,
        cfg: &RivetConfig,
        session_id: &str,
        event_count: usize,
    ) -> Result<()> {
        let _ = self.jobs.enqueue_job(&WorkerJob::upsert_topics()).await;
        let _ = self
            .jobs
            .enqueue_job(&WorkerJob::new_pending(
                TASK_SUGGEST_TAGS,
                &format!("file-session:{session_id}"),
                serde_json::json!({ "session_id": session_id }).to_string(),
                PRIORITY_CLASSIFY,
            ))
            .await;
        self.enqueue_wiki_extract_after_compact(cfg, session_id).await;
        let still_uncovered = self.meta.covered_event_ids(session_id)?.len();
        if event_count.saturating_sub(still_uncovered) >= 10 {
            let _ = self
                .jobs
                .enqueue_job(&WorkerJob::compact_session_reason(session_id, "threshold"))
                .await;
        }
        Ok(())
    }

    /// Push root summary into matching topic `startup_context` + decisions.
    fn refresh_topic_memory_from_root(&self, session_id: &str) -> Result<()> {
        let Some(root) = self.meta.get_summary_for_session(session_id)? else {
            return Ok(());
        };
        let topics = self.meta.list_topics().unwrap_or_default();
        for topic in topics {
            if !topic.session_ids.iter().any(|s| s == session_id) {
                continue;
            }
            let ctx = format!("# {}\n\n{}", root.title, root.body);
            let _ = self.meta.set_startup_context(&topic.slug, &ctx);
            // Heuristic decision lines: sentences containing decide/chose/will/must.
            for line in root.body.split(['.', '\n']) {
                let t = line.trim();
                let lower = t.to_ascii_lowercase();
                if t.len() > 20
                    && (lower.contains("decid")
                        || lower.contains("chose")
                        || lower.contains("will ")
                        || lower.contains("must "))
                {
                    let _ = self.meta.append_decision(&topic.slug, t);
                }
            }
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    async fn write_leaf_summaries(
        &self,
        cfg: &RivetConfig,
        session_id: &str,
        events: &[CaptureEvent],
        project_id: Option<&str>,
        model: Option<&str>,
        start_idx: usize,
        overwrite: bool,
    ) -> Result<Vec<String>> {
        let mut leaf_ids = Vec::new();
        for (offset, batch) in events.chunks(10).enumerate() {
            let batch_idx = start_idx + offset;
            let id = format!("summary:{}:leaf:{batch_idx}", slugify(session_id));
            if !overwrite {
                if let Some(existing) = self.meta.get_summary(&id)? {
                    if existing.pipeline_version >= COMPACT_PIPELINE_VERSION {
                        leaf_ids.push(id);
                        continue;
                    }
                }
            }
            let digest = batch_digest(batch);
            let raw_body = if let Some(m) = model {
                self.chat_prompt(
                    cfg,
                    m,
                    "compact-leaf",
                    prompts::LEAF_SYSTEM_PROMPT,
                    &format!(
                        "[conversation]\n  id: {session_id}\n  messages: {} in this batch\n\n{digest}",
                        batch.len()
                    ),
                )
                .await
                .unwrap_or_else(|_| fallback_bullet_digest(batch))
            } else {
                fallback_bullet_digest(batch)
            };
            let body = work_first_strip(&raw_body);
            self.meta.upsert_summary(&SummaryMeta {
                id: id.clone(),
                session_id: session_id.to_string(),
                project_id: project_id.map(str::to_string),
                title: format!("Leaf {}", batch_idx + 1),
                body,
                event_ids: batch.iter().map(|e| e.id.to_string()).collect(),
                message_count: batch.len() as u64,
                model: model.map(str::to_string),
                kind: SummaryKind::Leaf,
                parent_id: None,
                source_summary_ids: Vec::new(),
                depth: 0,
                pipeline_version: COMPACT_PIPELINE_VERSION,
                updated_at: Utc::now().to_rfc3339(),
            })?;
            leaf_ids.push(id);
        }
        Ok(leaf_ids)
    }

    async fn write_branch_summaries(
        &self,
        cfg: &RivetConfig,
        session_id: &str,
        leaf_ids: &[String],
        project_id: Option<&str>,
        model: Option<&str>,
    ) -> Result<Vec<String>> {
        let mut branch_ids = Vec::new();
        let chunks: Vec<&[String]> =
            if leaf_ids.len() >= 5 { leaf_ids.chunks(8).collect() } else { vec![leaf_ids] };
        for (branch_idx, chunk) in chunks.iter().enumerate() {
            let id = format!("summary:{}:branch:{branch_idx}", slugify(session_id));
            let leaves: Vec<SummaryMeta> =
                chunk.iter().filter_map(|lid| self.meta.get_summary(lid).ok().flatten()).collect();
            let digest = leaves
                .iter()
                .enumerate()
                .map(|(i, s)| {
                    format!("[Leaf #{:02} | {} msgs]\n{}", i + 1, s.message_count, s.body)
                })
                .collect::<Vec<_>>()
                .join("\n\n---\n\n");
            let raw_body = if let Some(m) = model {
                self.chat_prompt(
                    cfg,
                    m,
                    "compact-branch",
                    prompts::BRANCH_SYSTEM_PROMPT,
                    &format!(
                        "[conversation]\n  id: {session_id}\n  leaves: {} in this branch\n\n{digest}",
                        leaves.len()
                    ),
                )
                .await
                .unwrap_or_else(|_| digest.clone())
            } else {
                digest
            };
            let body = work_first_strip(&raw_body);
            self.meta.upsert_summary(&SummaryMeta {
                id: id.clone(),
                session_id: session_id.to_string(),
                project_id: project_id.map(str::to_string),
                title: format!("Branch {}", branch_idx + 1),
                body,
                event_ids: leaves.iter().flat_map(|s| s.event_ids.clone()).take(120).collect(),
                message_count: leaves.iter().map(|s| s.message_count).sum(),
                model: model.map(str::to_string),
                kind: SummaryKind::Branch,
                parent_id: None,
                source_summary_ids: chunk.to_vec(),
                depth: 1,
                pipeline_version: COMPACT_PIPELINE_VERSION,
                updated_at: Utc::now().to_rfc3339(),
            })?;
            for leaf_id in *chunk {
                if let Some(mut leaf) = self.meta.get_summary(leaf_id)? {
                    leaf.parent_id = Some(id.clone());
                    leaf.pipeline_version = COMPACT_PIPELINE_VERSION;
                    let _ = self.meta.upsert_summary(&leaf);
                }
            }
            branch_ids.push(id);
        }
        Ok(branch_ids)
    }

    async fn write_root_summary(
        &self,
        cfg: &RivetConfig,
        session_id: &str,
        events: &[CaptureEvent],
        branch_ids: &[String],
        project_id: Option<String>,
        model: Option<String>,
    ) -> Result<()> {
        let branches: Vec<SummaryMeta> =
            branch_ids.iter().filter_map(|id| self.meta.get_summary(id).ok().flatten()).collect();
        let digest = branches
            .iter()
            .enumerate()
            .map(|(i, s)| format!("[Branch #{:02} | {} msgs]\n{}", i + 1, s.message_count, s.body))
            .collect::<Vec<_>>()
            .join("\n\n---\n\n");
        let raw_body = if let Some(m) = model.as_deref() {
            self.chat_prompt(
                cfg,
                m,
                "compact-root",
                prompts::ROOT_SYSTEM_PROMPT,
                &format!(
                    "[conversation]\n  id: {session_id}\n  branches: {} in this root\n\n{digest}",
                    branches.len()
                ),
            )
            .await
            .unwrap_or_else(|_| digest.clone())
        } else {
            digest
        };
        let body = work_first_strip(&raw_body);
        let short = session_id.chars().take(12).collect::<String>();
        let title = if let Some(m) = model.as_deref() {
            self.chat_prompt(
                cfg,
                m,
                "compact-title",
                prompts::TITLE_SYSTEM_PROMPT,
                &format!("Summary:\n{body}"),
            )
            .await
            .ok()
            .and_then(|raw| {
                serde_json::from_str::<Value>(&raw)
                    .ok()
                    .and_then(|v| v.get("title")?.as_str().map(str::to_string))
                    .or_else(|| {
                        let t = raw.trim().trim_matches('"');
                        (!t.is_empty()).then(|| t.chars().take(72).collect())
                    })
            })
            .unwrap_or_else(|| format!("Session {short}"))
        } else {
            format!("Session {short}")
        };
        let mut lineage_events: Vec<String> =
            branches.iter().flat_map(|s| s.event_ids.clone()).collect();
        if lineage_events.is_empty() {
            lineage_events = events.iter().map(|e| e.id.to_string()).collect();
        }
        lineage_events.sort();
        lineage_events.dedup();
        let root_id = format!("summary:{}:root", slugify(session_id));
        self.meta.upsert_summary(&SummaryMeta {
            id: root_id.clone(),
            session_id: session_id.to_string(),
            project_id,
            title,
            body,
            event_ids: lineage_events.into_iter().take(200).collect(),
            message_count: events.len() as u64,
            model,
            kind: SummaryKind::Root,
            parent_id: None,
            source_summary_ids: branch_ids.to_vec(),
            depth: 2,
            pipeline_version: COMPACT_PIPELINE_VERSION,
            updated_at: Utc::now().to_rfc3339(),
        })?;
        for branch_id in branch_ids {
            if let Some(mut branch) = self.meta.get_summary(branch_id)? {
                branch.parent_id = Some(root_id.clone());
                branch.pipeline_version = COMPACT_PIPELINE_VERSION;
                let _ = self.meta.upsert_summary(&branch);
            }
        }
        Ok(())
    }

    async fn synthesize_tool_event(&self, cfg: &RivetConfig, event_id: &str) -> Result<()> {
        let Some(model) = cfg.wiki_model.as_deref() else {
            return Ok(());
        };
        let mut events = self.store.get_by_ids(&[event_id.to_string()]).await?;
        let Some(mut event) = events.pop() else {
            return Ok(());
        };
        hydrate_events(&self.paths, std::slice::from_mut(&mut event));
        let turns = normalize_event_turns(&event);
        let tool = turns.iter().find(|t| {
            t.kind == TurnKind::Tool
                && t.tool_name.as_deref().is_some_and(|n| !n.is_empty())
                && t.text.trim().is_empty()
        });
        let Some(tool) = tool else {
            // Also accept assistant tool_use with args and empty prose.
            let tool = turns.iter().find(|t| {
                t.tool_name.as_deref().is_some_and(|n| !n.is_empty())
                    && t.tool_args.as_deref().is_some_and(|a| !a.trim().is_empty())
                    && t.text.trim().is_empty()
            });
            let Some(tool) = tool else {
                return Ok(());
            };
            return self.write_tool_sentence(cfg, model, &event, tool).await;
        };
        self.write_tool_sentence(cfg, model, &event, tool).await
    }

    async fn write_tool_sentence(
        &self,
        cfg: &RivetConfig,
        model: &str,
        event: &CaptureEvent,
        tool: &rivet_core::NormalizedTurn,
    ) -> Result<()> {
        let name = tool.tool_name.as_deref().unwrap_or("tool");
        let args = tool.tool_args.as_deref().unwrap_or("{}");
        let raw = self
            .chat_prompt(
                cfg,
                model,
                "tool-synth",
                prompts::TOOL_SYNTH_SYSTEM_PROMPT,
                &format!("tool_name: {name}\ntool_args: {args}\n"),
            )
            .await?;
        let Some(sentence) = prompts::valid_tool_sentence(&raw) else {
            anyhow::bail!("invalid tool sentence");
        };
        if cfg.capabilities.vector_search {
            let _ = self
                .ch
                .upsert_embeddings_batch(
                    LEXICAL_SPACE,
                    &[(event.id.to_string(), lexical_embed(sentence))],
                )
                .await;
        }
        let _ = self.meta.append_enrichment(&rivet_store::EnrichmentEvent {
            id: format!("tool-synth:{}", event.id),
            session_id: event.session_id.clone().unwrap_or_default(),
            kind: "tool_synth".into(),
            text: Some(sentence.to_string()),
            tool: Some(name.to_string()),
            provider: Some(provider_key(event)),
            ts: Utc::now().to_rfc3339(),
        });
        // Also prepend the sentence into content so keyword search sees it.
        if let Ok(mut events) = self.store.get_by_ids(&[event.id.to_string()]).await {
            if let Some(mut ev) = events.pop() {
                let existing = ev.content.unwrap_or_default();
                if !existing.contains(sentence) {
                    ev.content = Some(format!("{sentence}\n---\n{existing}"));
                    let _ = self.store.insert_event(&ev).await;
                }
            }
        }
        Ok(())
    }

    async fn file_session_topic(&self, cfg: &RivetConfig, session_id: &str) -> Result<()> {
        let topics = self.meta.list_topics().unwrap_or_default();
        // Never move sessions already on a You-curated topic.
        for topic in &topics {
            if topic.placement_by == PlacementBy::You
                && topic.session_ids.iter().any(|s| s == session_id)
            {
                return Ok(());
            }
        }
        let Some(summary) = self.meta.get_summary_for_session(session_id)? else {
            return Ok(());
        };
        let Some(model) = cfg.wiki_model.as_deref() else {
            return Ok(());
        };
        let catalog = topics
            .iter()
            .enumerate()
            .map(|(i, t)| format!("T{}: {} ({})", i + 1, t.title, t.slug))
            .collect::<Vec<_>>()
            .join("\n");
        let raw = self
            .chat_prompt(
                cfg,
                model,
                "file-topic",
                prompts::FILING_SYSTEM_PROMPT,
                &format!(
                    "Catalog:\n{catalog}\n\nTitle: {}\nSummary:\n{}\n",
                    summary.title, summary.body
                ),
            )
            .await?;
        let parsed: Value = serde_json::from_str(raw.trim()).unwrap_or_else(|_| json!({}));
        if parsed.get("none").and_then(Value::as_bool) == Some(true) {
            return Ok(());
        }
        if let Some(file) = parsed.get("file").and_then(Value::as_str) {
            if let Ok(idx) = file.trim().trim_start_matches('T').parse::<usize>() {
                if let Some(topic) = topics.get(idx.saturating_sub(1)) {
                    if topic.placement_by == PlacementBy::You {
                        return Ok(());
                    }
                    let mut next = topic.clone();
                    if !next.session_ids.iter().any(|s| s == session_id) {
                        next.session_ids.push(session_id.to_string());
                    }
                    next.placement_by = PlacementBy::Categorizer;
                    next.updated_at = Utc::now().to_rfc3339();
                    let _ = self.meta.upsert_topic(&next);
                }
            }
        } else if let Some(name) = parsed.get("suggest").and_then(Value::as_str) {
            let slug = slugify(name);
            // Optional parent from `{"suggest":"…","under":"T<n>"}` — never exceed depth cap.
            let under = parsed
                .get("under")
                .and_then(Value::as_str)
                .and_then(|u| {
                    let idx = u.trim().trim_start_matches('T').parse::<usize>().ok()?;
                    topics.get(idx.saturating_sub(1)).map(|t| t.slug.clone())
                })
                .filter(|parent| rivet_store::can_nest_under(&topics, parent));
            let proposal = TidyProposal {
                id: format!("tidy:create:{slug}"),
                action: "create".into(),
                from_slug: None,
                to_slug: under,
                title: Some(name.to_string()),
                reason: format!("Categorizer suggestion for session {session_id}"),
                status: "pending".into(),
                created_at: Utc::now().to_rfc3339(),
            };
            let _ = self.meta.upsert_tidy_proposal(&proposal);
        }
        // Occasional tidy sweep when many topics exist.
        if topics.len() >= 8 {
            let _ = self.propose_tidy(cfg, &topics).await;
        }
        Ok(())
    }

    async fn suggest_session_tags(&self, cfg: &RivetConfig, session_id: &str) -> Result<()> {
        let Some(model) = cfg.wiki_model.as_deref() else {
            return Ok(());
        };
        let Some(summary) = self.meta.get_summary_for_session(session_id)? else {
            return Ok(());
        };
        let raw = self
            .chat_prompt(
                cfg,
                model,
                "suggest-tags",
                "Suggest 1 to 5 short key:value tags for this coding session. Reply with a JSON array of strings only, e.g. [\"project:rivet\",\"topic:auth\"]. Prefer project:, topic:, lang:, area:. Never invent secrets.",
                &format!("Title: {}\n\n{}", summary.title, summary.body),
            )
            .await?;
        let tags: Vec<String> = serde_json::from_str(raw.trim())
            .ok()
            .or_else(|| {
                let start = raw.find('[')?;
                let end = raw.rfind(']')?;
                serde_json::from_str(&raw[start..=end]).ok()
            })
            .unwrap_or_default();
        for tag in tags.into_iter().take(5) {
            let tag = tag.trim().to_string();
            if !tag.contains(':') || tag.len() < 3 {
                continue;
            }
            let id = format!("tag:{session_id}:{tag}");
            let _ = self.meta.upsert_tag_suggestion(&rivet_store::TagSuggestion {
                id,
                session_id: session_id.to_string(),
                tag,
                status: "suggested".into(),
                created_at: Utc::now().to_rfc3339(),
            });
        }
        Ok(())
    }

    async fn enqueue_pending_wiki_extracts(&self) -> Result<()> {
        let cursor = self.meta.job_cursor("wiki_extract").ok().flatten();
        let mut summaries = self.meta.list_summaries().unwrap_or_default();
        summaries.sort_by(|a, b| a.updated_at.cmp(&b.updated_at));
        let mut jobs = Vec::new();
        for summary in summaries
            .into_iter()
            .filter(|s| matches!(s.kind, SummaryKind::Root))
            .filter(|s| cursor.as_ref().is_none_or(|c| s.updated_at.as_str() > c.as_str()))
            .take(16)
        {
            let routes = self.wiki_extract_routes(&summary);
            jobs.push(WorkerJob::extract_wiki_summary_routes(&summary.id, &routes));
        }
        if !jobs.is_empty() {
            self.jobs.enqueue_jobs(&jobs).await?;
        }
        Ok(())
    }

    /// Route keys used to coalesce sibling extract jobs (session + topic slugs).
    fn wiki_extract_routes(&self, summary: &SummaryMeta) -> Vec<String> {
        let mut routes = vec![format!("session:{}", summary.session_id)];
        let topics = self.meta.list_topics().unwrap_or_default();
        for topic in topics {
            if topic.kind == "entity" || topic.kind == "type" {
                continue;
            }
            if topic.session_ids.iter().any(|s| s == &summary.session_id) {
                let slug = wiki_page::normalize_slug(&topic.slug);
                if !slug.is_empty() {
                    let route = format!("topic:{slug}");
                    if !routes.contains(&route) {
                        routes.push(route);
                    }
                }
            }
        }
        // Cold sessions: provisional topic routes from the summary title.
        if routes.len() == 1 {
            for token in summary.title.split(|c: char| !c.is_ascii_alphanumeric()) {
                let slug = wiki_page::normalize_slug(token);
                if slug.len() < 4 {
                    continue;
                }
                let route = format!("topic:{slug}");
                if !routes.contains(&route) {
                    routes.push(route);
                }
                if routes.len() >= 4 {
                    break;
                }
            }
        }
        routes
    }

    async fn extract_one_summary(
        &self,
        cfg: &RivetConfig,
        summary_id: &str,
        payload_routes: &[String],
        worker_id: &str,
        lead_job_key: &str,
    ) -> Result<()> {
        let Some(model) = cfg.wiki_model.as_deref() else {
            return Ok(());
        };
        let Some(lead) = self.meta.get_summary(summary_id)? else {
            return Ok(());
        };
        if !matches!(lead.kind, SummaryKind::Root) {
            return Ok(());
        }
        let mut routes = if payload_routes.is_empty() {
            self.wiki_extract_routes(&lead)
        } else {
            payload_routes.to_vec()
        };
        // Always include session route so same-session siblings can join.
        let session_route = format!("session:{}", lead.session_id);
        if !routes.iter().any(|r| r == &session_route) {
            routes.push(session_route);
        }

        let gathered = self.gather_extract_siblings(worker_id, lead_job_key, &routes).await?;
        let sibling_bodies: Vec<String> =
            gathered.iter().filter_map(|g| g.summary.as_ref().map(|s| s.body.clone())).collect();
        let coalesced = wiki_page::coalesce_summary_bodies(
            &lead.body,
            sibling_bodies.iter().map(String::as_str),
        );

        let project = &cfg.wiki_project_id;
        let wiki_root = self.paths.wiki_dir();
        let existing = self.existing_page_inventory(wiki_root.as_std_path(), project, &lead);
        let prompt = format!(
            "Title: {}\nSession: {}\nSummary id: {}\nRoutes: {}\nCoalesced siblings: {}\n\nExisting pages:\n{}\n\nMaterial:\n{}",
            lead.title,
            lead.session_id,
            lead.id,
            routes.join(", "),
            gathered.len(),
            if existing.is_empty() {
                "_none_".into()
            } else {
                existing
            },
            coalesced
        );

        let raw = match self
            .chat_prompt_schema(
                cfg,
                model,
                "wiki-extract",
                prompts::WIKI_EXTRACT_SYSTEM_PROMPT,
                &prompt,
                SchemaConstraint { name: "wiki_extract", schema: wiki_schema::extract_schema() },
            )
            .await
        {
            Ok(text) => text,
            Err(err) => {
                self.release_gathered(gathered).await;
                return Err(err);
            },
        };
        let mut patches = wiki_page::parse_wiki_patches(&raw);
        stamp_extract_citations(&mut patches, &lead, &gathered);
        self.apply_extracted_wiki_patches(wiki_root.as_std_path(), project, &lead, &patches).await;
        for g in gathered {
            let key = g.claimed.job.job_key.clone();
            if let Err(err) = self.jobs.complete_job(g.claimed, true, None).await {
                warn!(?err, job_key = %key, "failed to complete coalesced extract");
            }
        }
        let _ = self.meta.set_job_cursor("wiki_extract", &lead.updated_at);
        self.ensure_entities_type_root(project);
        self.consolidate_entity_topics();
        Ok(())
    }

    async fn release_gathered(&self, gathered: Vec<GatheredExtract>) {
        for g in gathered {
            let key = g.claimed.job.job_key.clone();
            if let Err(err) = self.jobs.release_job(g.claimed).await {
                warn!(?err, job_key = %key, "failed to release coalesced extract");
            }
        }
    }

    /// Pull sibling extract-wiki jobs from NATS whose routes overlap the lead.
    async fn gather_extract_siblings(
        &self,
        worker_id: &str,
        lead_job_key: &str,
        routes: &[String],
    ) -> Result<Vec<GatheredExtract>> {
        let batch = self
            .jobs
            .gather_extract_siblings(worker_id, lead_job_key, routes, 32)
            .await
            .unwrap_or_default();
        let mut gathered = Vec::new();
        let mut used_chars = 0usize;
        for claimed in batch {
            if payload_str_opt(&claimed.job.payload, "summary_id").is_none() {
                let _ = self.jobs.release_job(claimed).await;
                continue;
            }
            let Some(summary_id) = payload_str_opt(&claimed.job.payload, "summary_id") else {
                let _ = self.jobs.release_job(claimed).await;
                continue;
            };
            let Ok(Some(summary)) = self.meta.get_summary(&summary_id) else {
                let _ = self.jobs.release_job(claimed).await;
                continue;
            };
            if !matches!(summary.kind, SummaryKind::Root) {
                let _ = self.jobs.release_job(claimed).await;
                continue;
            }
            if used_chars + summary.body.len() > wiki_page::COALESCE_CHARS && !gathered.is_empty() {
                let _ = self.jobs.release_job(claimed).await;
                break;
            }
            if gathered.len() >= wiki_page::COALESCE_MORE {
                let _ = self.jobs.release_job(claimed).await;
                break;
            }
            used_chars = used_chars.saturating_add(summary.body.len());
            gathered.push(GatheredExtract { claimed, summary: Some(summary) });
        }
        if !gathered.is_empty() {
            info!(
                siblings = gathered.len(),
                routes = %routes.join(","),
                "wiki extract coalesced sibling jobs"
            );
        }
        Ok(gathered)
    }

    fn existing_page_inventory(
        &self,
        wiki_root: &std::path::Path,
        project: &str,
        lead: &SummaryMeta,
    ) -> String {
        let topics = self.meta.list_topics().unwrap_or_default();
        let mut inventories = Vec::new();
        for topic in topics
            .into_iter()
            .filter(|t| t.session_ids.iter().any(|s| s == &lead.session_id))
            .take(5)
        {
            let path = wiki_root.join(project).join("topics").join(format!("{}.md", topic.slug));
            if !path.is_file() {
                continue;
            }
            let raw = std::fs::read_to_string(&path).unwrap_or_default();
            if !wiki_page::is_knowledge_page(&raw) {
                continue;
            }
            let page = wiki_page::parse_wiki_page(&topic.slug, &raw);
            inventories.push(wiki_page::page_inventory(&page));
        }
        // Also include a few recent knowledge pages by mtime-ish listing.
        if inventories.len() < 3 {
            let dir = wiki_root.join(project).join("topics");
            if let Ok(entries) = std::fs::read_dir(&dir) {
                for entry in entries.flatten().take(12) {
                    let path = entry.path();
                    if path.extension().and_then(|e| e.to_str()) != Some("md") {
                        continue;
                    }
                    let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                        continue;
                    };
                    if stem.eq_ignore_ascii_case("index") {
                        continue;
                    }
                    if inventories.iter().any(|inv| inv.contains(&format!("slug: {stem}"))) {
                        continue;
                    }
                    let raw = std::fs::read_to_string(&path).unwrap_or_default();
                    if !wiki_page::is_knowledge_page(&raw) {
                        continue;
                    }
                    inventories
                        .push(wiki_page::page_inventory(&wiki_page::parse_wiki_page(stem, &raw)));
                    if inventories.len() >= 5 {
                        break;
                    }
                }
            }
        }
        inventories.join("\n---\n")
    }

    async fn extract_wiki_from_summaries(&self, cfg: &RivetConfig) -> Result<()> {
        // Tick path prefers enqueue; inline extract is a liveness fallback only.
        let cursor = self.meta.job_cursor("wiki_extract").ok().flatten();
        let mut summaries = self.meta.list_summaries().unwrap_or_default();
        summaries.sort_by(|a, b| a.updated_at.cmp(&b.updated_at));
        let next = summaries
            .into_iter()
            .filter(|s| matches!(s.kind, SummaryKind::Root))
            .find(|s| cursor.as_ref().is_none_or(|c| s.updated_at.as_str() > c.as_str()));
        if let Some(lead) = next {
            let routes = self.wiki_extract_routes(&lead);
            let job_key = format!("extract-wiki:{}", lead.id);
            let _ = self.extract_one_summary(cfg, &lead.id, &routes, "wiki-tick", &job_key).await;
        }
        Ok(())
    }

    async fn apply_extracted_wiki_patches(
        &self,
        wiki_root: &std::path::Path,
        project: &str,
        lead: &SummaryMeta,
        patches: &[wiki_page::PagePatch],
    ) {
        let cfg = self.config.read().await.clone();
        for patch in patches {
            let mut patch = patch.clone();
            if let Some(merged) =
                self.maybe_merge_existing_topic(&cfg, wiki_root, project, &patch).await
            {
                patch = merged;
            }
            match wiki_page::apply_topic_patch(wiki_root, project, &patch) {
                Ok(topic_path) => {
                    let _ = self.meta.upsert_wiki_page(&WikiPageMeta {
                        id: format!("{project}/topics/{}", patch.slug),
                        project_id: project.to_string(),
                        title: patch.title.clone(),
                        path: relative_wiki_path(&self.paths, &topic_path),
                        updated_at: Utc::now().to_rfc3339(),
                    });
                    let mut event_ids = lead.event_ids.clone();
                    let mut session_ids = vec![lead.session_id.clone()];
                    if let Ok(Some(prev)) = self.meta.get_topic(&patch.slug) {
                        for eid in prev.event_ids {
                            if !event_ids.contains(&eid) {
                                event_ids.push(eid);
                            }
                        }
                        for sid in prev.session_ids {
                            if !session_ids.contains(&sid) {
                                session_ids.push(sid);
                            }
                        }
                    }
                    let _ = self.meta.upsert_topic(&TopicMeta {
                        slug: patch.slug.clone(),
                        title: patch.title.clone(),
                        project_id: project.to_string(),
                        aliases: patch.aliases.clone(),
                        tags: patch.tags.clone(),
                        event_ids,
                        session_ids,
                        summary: patch.summary.clone().map(|s| wiki_page::normalize_summary(&s)),
                        curated: false,
                        placement_by: PlacementBy::Categorizer,
                        decisions: Vec::new(),
                        startup_context: None,
                        kind: "work".into(),
                        parent_slug: None,
                        updated_at: Utc::now().to_rfc3339(),
                    });
                    if wiki_page::page_archive_bytes(wiki_root, project, &patch.slug)
                        >= wiki_page::RECOMPILE_BYTES
                    {
                        let job = WorkerJob::new_pending(
                            TASK_RECOMPILE_WIKI,
                            &format!("recompile-wiki:{}", patch.slug),
                            serde_json::json!({ "slug": patch.slug }).to_string(),
                            PRIORITY_BACKFILL,
                        );
                        let _ = self.jobs.enqueue_jobs(&[job]).await;
                    }
                    self.apply_extracted_entities(wiki_root, project, lead, &patch);
                },
                Err(err) => warn!(?err, slug = %patch.slug, "wiki topic patch failed"),
            }
        }
    }

    /// When updating an existing knowledge page with a full article rewrite,
    /// ask the model to merge against the current page (RivetHub-style apply merge).
    async fn maybe_merge_existing_topic(
        &self,
        cfg: &RivetConfig,
        wiki_root: &std::path::Path,
        project: &str,
        patch: &wiki_page::PagePatch,
    ) -> Option<wiki_page::PagePatch> {
        let article = patch.article.as_deref()?.trim();
        if article.is_empty() || !patch.article_patches.is_empty() {
            return None;
        }
        let model = cfg.wiki_model.as_deref()?;
        let topic_path = wiki_root.join(project).join("topics").join(format!("{}.md", patch.slug));
        if !topic_path.is_file() {
            return None;
        }
        let raw = std::fs::read_to_string(&topic_path).ok()?;
        if !wiki_page::is_knowledge_page(&raw) {
            return None;
        }
        let page = wiki_page::parse_wiki_page(&patch.slug, &raw);
        let user = format!(
            "Slug: {}\nTitle: {}\n\nCurrent page:\n{}\n\nNew material:\n{}\n\nProposed summary:\n{}",
            patch.slug,
            patch.title,
            wiki_page::render_wiki_page(&page),
            article,
            patch.summary.as_deref().unwrap_or("")
        );
        let merged_raw = self
            .chat_prompt_schema(
                cfg,
                model,
                "wiki-merge",
                prompts::WIKI_MERGE_SYSTEM_PROMPT,
                &user,
                SchemaConstraint {
                    name: "wiki_recompile",
                    schema: wiki_schema::recompile_schema(),
                },
            )
            .await
            .ok()?;
        let mut next = parse_recompile_response(&patch.slug, &page, &merged_raw)?;
        next.action = wiki_page::WikiAction::Update;
        next.aliases.clone_from(&patch.aliases);
        next.tags.clone_from(&patch.tags);
        next.entities.clone_from(&patch.entities);
        next.related.clone_from(&patch.related);
        next.citations.clone_from(&patch.citations);
        next.sources.clone_from(&patch.sources);
        next.entity_type.clone_from(&patch.entity_type);
        next.allow_shrink = patch.allow_shrink;
        if next.history_entry.is_none() {
            next.history_entry.clone_from(&patch.history_entry);
        }
        Some(next)
    }

    fn apply_extracted_entities(
        &self,
        wiki_root: &std::path::Path,
        project: &str,
        lead: &SummaryMeta,
        patch: &wiki_page::PagePatch,
    ) {
        for ent in patch.entities.iter().take(8) {
            let (entity_type, title) = parse_entity_label(ent);
            let slug = slugify(&title);
            if slug.is_empty() {
                continue;
            }
            let mention =
                format!("- [{}](../topics/{}.md) — {}", patch.title, patch.slug, lead.title);
            let entity_patch = wiki_page::PagePatch {
                action: wiki_page::WikiAction::Update,
                slug: slug.clone(),
                title: title.clone(),
                summary: Some(format!("Currently, {title} appears in project knowledge.")),
                article: None,
                article_patches: vec![wiki_page::ArticlePatch {
                    heading: "Mentions".into(),
                    body: mention,
                    mode: wiki_page::PatchMode::Append,
                }],
                history_entry: Some(format!("Mentioned in {}", lead.title)),
                aliases: Vec::new(),
                tags: vec!["entity".into()],
                entities: Vec::new(),
                related: vec![patch.slug.clone()],
                citations: vec![wiki_page::PageCitation {
                    id: lead.id.clone(),
                    kind: "summary".into(),
                    date: Some(Utc::now().format("%Y-%m-%d").to_string()),
                    note: Some(lead.title.clone()),
                }],
                sources: vec![wiki_page::PageSource {
                    id: lead.id.clone(),
                    label: lead.title.clone(),
                }],
                entity_type: entity_type.clone(),
                allow_shrink: false,
            };
            if let Ok(ent_path) = wiki_page::apply_entity_patch(wiki_root, project, &entity_patch) {
                let id_suffix = wiki_page::entity_rel_path(&slug, entity_type.as_deref())
                    .trim_end_matches(".md")
                    .to_string();
                let _ = self.meta.upsert_wiki_page(&WikiPageMeta {
                    id: format!("{project}/{id_suffix}"),
                    project_id: project.to_string(),
                    title: title.clone(),
                    path: relative_wiki_path(&self.paths, &ent_path),
                    updated_at: Utc::now().to_rfc3339(),
                });
                let mut tags = vec!["entity".into()];
                if let Some(kind) = entity_type.as_deref() {
                    tags.push(format!("type:{kind}"));
                }
                let _ = self.meta.upsert_topic(&TopicMeta {
                    slug: format!("entity:{slug}"),
                    title: title.clone(),
                    project_id: project.to_string(),
                    aliases: Vec::new(),
                    tags,
                    event_ids: Vec::new(),
                    session_ids: vec![lead.session_id.clone()],
                    summary: entity_patch.summary,
                    curated: false,
                    placement_by: PlacementBy::Categorizer,
                    decisions: Vec::new(),
                    startup_context: None,
                    kind: "entity".into(),
                    parent_slug: Some("type:entities".into()),
                    updated_at: Utc::now().to_rfc3339(),
                });
            }
        }
    }

    fn ensure_entities_type_root(&self, project: &str) {
        let _ = self.meta.upsert_topic(&TopicMeta {
            slug: "type:entities".into(),
            title: "Entities".into(),
            project_id: project.to_string(),
            aliases: Vec::new(),
            tags: Vec::new(),
            event_ids: Vec::new(),
            session_ids: Vec::new(),
            summary: Some("Currently, entity topics live under this type root.".into()),
            curated: true,
            placement_by: PlacementBy::You,
            decisions: Vec::new(),
            startup_context: None,
            kind: "type".into(),
            parent_slug: None,
            updated_at: Utc::now().to_rfc3339(),
        });
    }

    async fn enqueue_wiki_backfill(&self) -> Result<()> {
        let project = self.config.read().await.wiki_project_id.clone();
        let wiki_root = self.paths.wiki_dir();
        let topics_dir = wiki_root.join(&project).join("topics");
        let Ok(entries) = std::fs::read_dir(topics_dir.as_std_path()) else {
            return Ok(());
        };
        let mut jobs = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            if stem.eq_ignore_ascii_case("index") {
                continue;
            }
            let bytes = wiki_page::page_archive_bytes(wiki_root.as_std_path(), &project, stem);
            if bytes >= wiki_page::RECOMPILE_BYTES {
                jobs.push(WorkerJob::new_pending(
                    TASK_RECOMPILE_WIKI,
                    &format!("recompile-wiki:{stem}"),
                    serde_json::json!({ "slug": stem }).to_string(),
                    PRIORITY_BACKFILL,
                ));
            } else if bytes > wiki_page::ARTICLE_BUDGET {
                jobs.push(WorkerJob::new_pending(
                    TASK_CONSOLIDATE_WIKI,
                    &format!("consolidate-wiki:{stem}"),
                    serde_json::json!({ "slug": stem }).to_string(),
                    PRIORITY_BACKFILL,
                ));
            }
        }
        jobs.push(WorkerJob::new_pending(
            TASK_CONSOLIDATE_WIKI,
            "consolidate-wiki:project",
            "{}",
            PRIORITY_BACKFILL,
        ));
        self.jobs.enqueue_jobs(&jobs).await?;
        info!(count = jobs.len(), "enqueued wiki backfill jobs");
        Ok(())
    }

    async fn enqueue_wiki_extract_after_compact(&self, cfg: &RivetConfig, session_id: &str) {
        if !cfg.capabilities.wiki {
            return;
        }
        let Ok(Some(root)) = self.meta.get_summary_for_session(session_id) else {
            return;
        };
        if matches!(root.kind, SummaryKind::Root) {
            let routes = self.wiki_extract_routes(&root);
            let _ = self
                .jobs
                .enqueue_job(&WorkerJob::extract_wiki_summary_routes(&root.id, &routes))
                .await;
        }
    }

    fn consolidate_wiki_project(&self, cfg: &RivetConfig) {
        let project = &cfg.wiki_project_id;
        let wiki_root = self.paths.wiki_dir();
        let topics_dir = wiki_root.join(project).join("topics");
        let Ok(entries) = std::fs::read_dir(topics_dir.as_std_path()) else {
            return;
        };
        let mut stats = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            if stem.eq_ignore_ascii_case("index") {
                continue;
            }
            let raw = std::fs::read_to_string(&path).unwrap_or_default();
            if !wiki_page::is_knowledge_page(&raw) {
                continue;
            }
            let page = wiki_page::parse_wiki_page(stem, &raw);
            stats.push(wiki_page::WikiTopicStats {
                slug: stem.to_string(),
                title: page.title,
                citations: page.citations.len() as u64,
                history: page.history.len() as u64,
                bound: wiki_page::page_archive_bytes(wiki_root.as_std_path(), project, stem)
                    > wiki_page::ARTICLE_BUDGET,
            });
        }
        let plan = wiki_page::consolidation_plan(&stats, 2, 50);
        for fold in plan {
            for child in &fold.children {
                let _ = wiki_page::fold_page(wiki_root.as_std_path(), project, &fold.parent, child);
                let _ = self.meta.delete_wiki_page(&format!("{project}/topics/{child}"));
                let _ = self.meta.delete_topic(child);
            }
            info!(
                parent = %fold.parent,
                children = fold.children.len(),
                "wiki identity consolidate"
            );
        }
    }

    fn consolidate_wiki_topic(&self, cfg: &RivetConfig, slug: &str) -> Result<()> {
        let project = &cfg.wiki_project_id;
        let wiki_root = self.paths.wiki_dir();
        let page_path = wiki_root.join(project).join("topics").join(format!("{slug}.md"));
        if !page_path.as_std_path().is_file() {
            return Ok(());
        }
        let raw = std::fs::read_to_string(page_path.as_std_path())?;
        if !wiki_page::is_knowledge_page(&raw) {
            return Ok(());
        }
        let mut page = wiki_page::parse_wiki_page(slug, &raw);
        // Fold identity/stem twins that list this slug as related, plus thin related.
        let related = page.related.clone();
        for child in related.into_iter().take(8) {
            let child_path = wiki_root.join(project).join("topics").join(format!("{child}.md"));
            if !child_path.as_std_path().is_file() {
                continue;
            }
            let child_raw = std::fs::read_to_string(child_path.as_std_path()).unwrap_or_default();
            let (parent_id, _) = wiki_page::topic_identity(slug, &page.title);
            let child_page = wiki_page::parse_wiki_page(&child, &child_raw);
            let (child_id, _) = wiki_page::topic_identity(&child, &child_page.title);
            let thin = child_raw.len() <= wiki_page::SECTION_BUDGET;
            if !(thin || parent_id == child_id) {
                continue;
            }
            let _ = wiki_page::fold_page(wiki_root.as_std_path(), project, slug, &child);
            let _ = self.meta.delete_wiki_page(&format!("{project}/topics/{child}"));
            let _ = self.meta.delete_topic(&child);
        }
        let raw = std::fs::read_to_string(page_path.as_std_path()).unwrap_or(raw);
        page = wiki_page::parse_wiki_page(slug, &raw);
        let archived = wiki_page::bound_page(&mut page);
        if !archived.is_empty() {
            let _ = wiki_page::settle_archive(wiki_root.as_std_path(), project, slug, &archived)?;
            page.history.push(format!(
                "- {} — Consolidated; archived {} overflow block(s).",
                Utc::now().format("%Y-%m-%d"),
                archived.len()
            ));
        }
        std::fs::write(page_path.as_std_path(), wiki_page::render_wiki_page(&page))?;
        let _ = self.meta.upsert_wiki_page(&WikiPageMeta {
            id: format!("{project}/topics/{slug}"),
            project_id: project.clone(),
            title: page.title,
            path: relative_wiki_path(&self.paths, page_path.as_std_path()),
            updated_at: Utc::now().to_rfc3339(),
        });
        Ok(())
    }

    async fn recompile_wiki_topic(&self, cfg: &RivetConfig, slug: &str) -> Result<()> {
        let Some(model) = cfg.wiki_model.as_deref() else {
            return self.consolidate_wiki_topic(cfg, slug);
        };
        let project = &cfg.wiki_project_id;
        let wiki_root = self.paths.wiki_dir();
        let page_path = wiki_root.join(project).join("topics").join(format!("{slug}.md"));
        if !page_path.as_std_path().is_file() {
            return Ok(());
        }
        let raw = std::fs::read_to_string(page_path.as_std_path())?;
        if !wiki_page::is_knowledge_page(&raw) {
            return Ok(());
        }
        let page = wiki_page::parse_wiki_page(slug, &raw);
        let mut archive_notes = String::new();
        for file in wiki_page::list_archive_segments(wiki_root.as_std_path(), project, slug)
            .into_iter()
            .take(4)
        {
            let path = wiki_root.join(project).join("archive").join(slug).join(&file);
            if let Ok(body) = std::fs::read_to_string(path.as_std_path()) {
                let _ = writeln!(
                    archive_notes,
                    "### {file}\n\n{}\n",
                    body.chars().take(4_000).collect::<String>()
                );
            }
        }
        let mut citing = String::new();
        for c in page.citations.iter().filter(|c| c.kind == "summary").take(6) {
            if let Ok(Some(summary)) = self.meta.get_summary(&c.id) {
                let _ = writeln!(citing, "## {}\n\n{}\n", summary.title, summary.body);
            }
        }
        if citing.is_empty() {
            citing = self
                .meta
                .list_summaries()
                .unwrap_or_default()
                .into_iter()
                .filter(|s| s.body.contains(slug) || s.title.to_ascii_lowercase().contains(slug))
                .take(3)
                .map(|s| format!("## {}\n\n{}", s.title, s.body))
                .collect::<Vec<_>>()
                .join("\n\n");
        }
        let user = format!(
            "Slug: {slug}\nTitle: {}\n\nCurrent page:\n{}\n\nArchive notes:\n{}\n\nCiting summaries:\n{citing}",
            page.title,
            wiki_page::render_wiki_page(&page),
            if archive_notes.is_empty() {
                "_none_".into()
            } else {
                archive_notes
            }
        );
        let raw = self
            .chat_prompt_schema(
                cfg,
                model,
                "wiki-recompile",
                prompts::WIKI_RECOMPILE_SYSTEM_PROMPT,
                &user,
                SchemaConstraint {
                    name: "wiki_recompile",
                    schema: wiki_schema::recompile_schema(),
                },
            )
            .await
            .unwrap_or_default();
        let mut patch =
            parse_recompile_response(slug, &page, &raw).unwrap_or_else(|| wiki_page::PagePatch {
                action: wiki_page::WikiAction::Update,
                slug: slug.to_string(),
                title: page.title.clone(),
                summary: Some(page.summary.clone()),
                article: Some(page.article.clone()),
                article_patches: Vec::new(),
                history_entry: Some("Recompiled oversized page.".into()),
                aliases: page.aliases.clone(),
                tags: page.tags.clone(),
                entities: page.entities.clone(),
                related: page.related.clone(),
                citations: page.citations.clone(),
                sources: page.sources.clone(),
                entity_type: None,
                allow_shrink: true,
            });
        if patch.citations.is_empty() {
            patch.citations.clone_from(&page.citations);
        }
        if patch.sources.is_empty() {
            patch.sources.clone_from(&page.sources);
        }
        let topic_path = wiki_page::apply_topic_patch(wiki_root.as_std_path(), project, &patch)?;
        let _ = self.meta.upsert_wiki_page(&WikiPageMeta {
            id: format!("{project}/topics/{slug}"),
            project_id: project.clone(),
            title: patch.title,
            path: relative_wiki_path(&self.paths, &topic_path),
            updated_at: Utc::now().to_rfc3339(),
        });
        Ok(())
    }

    /// Fold duplicate entity:* topics that share a title into one slug.
    fn consolidate_entity_topics(&self) {
        let topics = self.meta.list_topics().unwrap_or_default();
        let mut by_title: BTreeMap<String, Vec<TopicMeta>> = BTreeMap::new();
        for topic in topics {
            if topic.kind != "entity" {
                continue;
            }
            by_title.entry(topic.title.to_ascii_lowercase()).or_default().push(topic);
        }
        for group in by_title.into_values() {
            if group.len() < 2 {
                continue;
            }
            let mut keep = group[0].clone();
            for extra in group.into_iter().skip(1) {
                for sid in extra.session_ids {
                    if !keep.session_ids.contains(&sid) {
                        keep.session_ids.push(sid);
                    }
                }
                for eid in extra.event_ids {
                    if !keep.event_ids.contains(&eid) {
                        keep.event_ids.push(eid);
                    }
                }
                let _ = self.meta.delete_topic(&extra.slug);
            }
            keep.updated_at = Utc::now().to_rfc3339();
            let _ = self.meta.upsert_topic(&keep);
        }
    }

    async fn propose_tidy(&self, cfg: &RivetConfig, topics: &[TopicMeta]) -> Result<()> {
        let Some(model) = cfg.wiki_model.as_deref() else {
            return Ok(());
        };
        let catalog = topics
            .iter()
            .map(|t| {
                format!(
                    "- {} | {} | sessions={} | placement={:?}",
                    t.slug,
                    t.title,
                    t.session_ids.len(),
                    t.placement_by
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        let raw =
            self.chat_prompt(cfg, model, "tidy", prompts::TIDY_SYSTEM_PROMPT, &catalog).await?;
        for line in raw.lines() {
            let line = line.trim();
            if line.is_empty() || !line.starts_with('{') {
                continue;
            }
            let Ok(v) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            let action = v.get("action").and_then(Value::as_str).unwrap_or("");
            if action.is_empty() {
                continue;
            }
            let from =
                v.get("from").or_else(|| v.get("slug")).and_then(Value::as_str).map(str::to_string);
            let to =
                v.get("to").or_else(|| v.get("under")).and_then(Value::as_str).map(str::to_string);
            let title = v.get("title").and_then(Value::as_str).map(str::to_string);
            let reason =
                v.get("reason").and_then(Value::as_str).unwrap_or("tidy proposal").to_string();
            let id =
                format!("tidy:{}:{}", action, from.as_deref().or(to.as_deref()).unwrap_or("x"));
            let _ = self.meta.upsert_tidy_proposal(&TidyProposal {
                id,
                action: action.into(),
                from_slug: from,
                to_slug: to,
                title,
                reason,
                status: "pending".into(),
                created_at: Utc::now().to_rfc3339(),
            });
        }
        Ok(())
    }

    async fn chat_prompt(
        &self,
        cfg: &RivetConfig,
        model: &str,
        internal: &str,
        system: &str,
        user: &str,
    ) -> Result<String> {
        self.chat_completions(cfg, model, internal, system, user, None).await
    }

    /// Chat with a schemars-backed JSON schema: injected into the system
    /// prompt and requested via `OpenAI` `response_format` (falls back if the
    /// upstream model/proxy rejects structured outputs).
    async fn chat_prompt_schema(
        &self,
        cfg: &RivetConfig,
        model: &str,
        internal: &str,
        system: &str,
        user: &str,
        constraint: SchemaConstraint,
    ) -> Result<String> {
        let system = format!(
            "{system}\n\nRespond with JSON only, matching this schema (`{}`):\n{}",
            constraint.name,
            serde_json::to_string_pretty(&constraint.schema).unwrap_or_else(|_| "{}".into())
        );
        let format = wiki_schema::response_format(constraint.name, &constraint.schema);
        match self.chat_completions(cfg, model, internal, &system, user, Some(format)).await {
            Ok(text) => Ok(text),
            Err(err) => {
                warn!(
                    ?err,
                    schema = constraint.name,
                    "structured output rejected; retrying without response_format"
                );
                self.chat_completions(cfg, model, internal, &system, user, None).await
            },
        }
    }

    async fn chat_completions(
        &self,
        cfg: &RivetConfig,
        model: &str,
        internal: &str,
        system: &str,
        user: &str,
        response_format: Option<Value>,
    ) -> Result<String> {
        let url = format!("{}/v1/chat/completions", cfg.proxy_base_url());
        let mut body = json!({
            "model": model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user}
            ],
            "temperature": 0.2,
        });
        if let Some(format) = response_format {
            body["response_format"] = format;
        }
        let res = self
            .http
            .post(&url)
            .bearer_auth(&cfg.proxy_access_key)
            .header("X-Rivet-Internal", internal)
            .json(&body)
            .send()
            .await
            .context("chat prompt")?;
        if !res.status().is_success() {
            anyhow::bail!("chat HTTP {}", res.status());
        }
        let parsed: Value = res.json().await.context("chat json")?;
        let text = parsed
            .pointer("/choices/0/message/content")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if text.is_empty() {
            anyhow::bail!("empty chat response");
        }
        Ok(text)
    }

    /// Cluster recent captures into durable topics (preserves curated fields).
    async fn upsert_topics(&self, cfg: &RivetConfig) -> Result<()> {
        let mut recent = self.store.recent(200).await?;
        hydrate_events(&self.paths, &mut recent);
        let clustered = cluster_topics(&recent);
        let now = Utc::now().to_rfc3339();
        for (title, events) in clustered {
            let slug = slugify(&title);
            let event_ids: Vec<String> = events.iter().take(40).map(|e| e.id.to_string()).collect();
            let mut session_ids: Vec<String> = events
                .iter()
                .filter_map(|e| e.session_id.clone())
                .collect::<std::collections::BTreeSet<_>>()
                .into_iter()
                .take(40)
                .collect();
            session_ids.sort();
            let summary = events.first().map(|e| {
                let line = format_event_line(e);
                if line.len() > 240 {
                    format!("{}…", &line[..240])
                } else {
                    line
                }
            });
            let topic = TopicMeta {
                slug,
                title,
                project_id: cfg.wiki_project_id.clone(),
                aliases: Vec::new(),
                tags: Vec::new(),
                event_ids,
                session_ids,
                summary,
                curated: false,
                placement_by: PlacementBy::Heuristic,
                decisions: Vec::new(),
                startup_context: None,
                kind: "work".into(),
                parent_slug: None,
                updated_at: now.clone(),
            };
            let _ = self.meta.upsert_topic(&topic)?;
        }
        self.meta.set_job_cursor("topics", &now)?;
        Ok(())
    }

    #[allow(clippy::too_many_lines)] // Wiki sections share ordering and TOC bookkeeping in one pass.
    async fn upsert_wiki(&self, cfg: &RivetConfig) -> Result<()> {
        let project = &cfg.wiki_project_id;
        let wiki_root = self.paths.wiki_dir().join(project);
        std::fs::create_dir_all(wiki_root.as_std_path())?;
        std::fs::create_dir_all(wiki_root.join("providers").as_std_path())?;
        std::fs::create_dir_all(wiki_root.join("topics").as_std_path())?;

        let totals = self.store.usage_totals().await?;
        let recent = self.store.recent(200).await?;
        // (title, relative_path) for every page except README — README is written last.
        let mut toc: Vec<(String, String)> = Vec::new();

        // --- Models ---
        let mut by_model: BTreeMap<String, (u64, u64, u64)> = BTreeMap::new();
        for e in &recent {
            let key = e.model.clone().unwrap_or_else(|| "(unknown)".into());
            let entry = by_model.entry(key).or_default();
            entry.0 += 1;
            entry.1 += u64::from(e.tokens_in);
            entry.2 += u64::from(e.tokens_out);
        }
        let mut models = String::from("# Models\n\n| Model | Events | Tokens in | Tokens out |\n| --- | ---: | ---: | ---: |\n");
        for (model, (n, tin, tout)) in &by_model {
            let _ = writeln!(models, "| `{model}` | {n} | {tin} | {tout} |");
        }
        self.write_wiki_page(project, "models", "Models", "models.md", &models)?;
        toc.push(("Models".into(), "models.md".into()));

        // --- Sessions ---
        let mut by_session: BTreeMap<String, Vec<&CaptureEvent>> = BTreeMap::new();
        for e in &recent {
            let key = e.session_id.clone().unwrap_or_else(|| "(no-session)".into());
            by_session.entry(key).or_default().push(e);
        }
        let mut sessions = String::from("# Sessions\n\n");
        for (sid, events) in by_session.iter().take(40) {
            let tokens: u64 =
                events.iter().map(|e| u64::from(e.tokens_in) + u64::from(e.tokens_out)).sum();
            let _ =
                writeln!(sessions, "## `{sid}`\n\n_{} events · {} tokens_\n", events.len(), tokens);
            sessions.push('\n');
            for e in events.iter().take(8) {
                let _ = writeln!(sessions, "- {}", format_event_line(e));
            }
            sessions.push('\n');
        }
        self.write_wiki_page(project, "sessions", "Sessions", "sessions.md", &sessions)?;
        toc.push(("Sessions".into(), "sessions.md".into()));

        // --- Topics (durable meta → markdown views) ---
        let topics = self.meta.list_topics().unwrap_or_default();
        let mut topics_index =
            String::from("# Topics\n\nDurable topics with citations (see also `/v1/topics`).\n\n");
        for topic in topics.iter().take(24) {
            let rel = format!("topics/{}.md", topic.slug);
            let title = &topic.title;
            let _ = writeln!(
                topics_index,
                "- [{title}]({}.md) — {} events · {} sessions{}",
                topic.slug,
                topic.event_ids.len(),
                topic.session_ids.len(),
                if topic.curated { " · curated" } else { "" }
            );
            let existing_path = wiki_root.join(&rel);
            if existing_path.as_std_path().is_file() {
                let existing =
                    std::fs::read_to_string(existing_path.as_std_path()).unwrap_or_default();
                if wiki_page::is_knowledge_page(&existing) {
                    // Knowledge extract owns this page — do not clobber with citation dump.
                    toc.push((title.clone(), rel));
                    continue;
                }
            }
            let mut page = format!("# {title}\n\n");
            if let Some(summary) = topic.summary.as_deref().filter(|s| !s.trim().is_empty()) {
                let _ = writeln!(page, "{summary}\n");
            }
            if !topic.aliases.is_empty() {
                let _ = writeln!(page, "_Aliases:_ {}\n", topic.aliases.join(", "));
            }
            if !topic.tags.is_empty() {
                let _ = writeln!(page, "_Tags:_ {}\n", topic.tags.join(", "));
            }
            page.push_str("## Citations\n\n");
            let cited = self
                .store
                .get_by_ids(&topic.event_ids.clone().into_iter().take(30).collect::<Vec<_>>())
                .await
                .unwrap_or_default();
            if cited.is_empty() {
                page.push_str("_No cited events yet._\n");
            } else {
                for e in &cited {
                    let _ = writeln!(page, "- {}", format_event_line(e));
                }
            }
            self.write_wiki_page(project, &format!("topics/{}", topic.slug), title, &rel, &page)?;
            toc.push((title.clone(), rel));
        }
        if topics.is_empty() {
            topics_index.push_str("\n_No topics yet — capture more events._\n");
        }
        self.write_wiki_page(project, "topics/index", "Topics", "topics/index.md", &topics_index)?;
        toc.push(("Topics".into(), "topics/index.md".into()));

        // --- Summaries ---
        let summaries = self.meta.list_summaries().unwrap_or_default();
        if !summaries.is_empty() {
            std::fs::create_dir_all(wiki_root.join("summaries").as_std_path())?;
            let mut index =
                String::from("# Summaries\n\nCompaction summaries for recent sessions.\n\n");
            for summary in summaries.iter().take(40) {
                let slug = slugify(&summary.session_id);
                let rel = format!("summaries/{slug}.md");
                let _ = writeln!(index, "- [{}]({slug}.md)", summary.title);
                let mut page = format!("# {}\n\n", summary.title);
                let _ = writeln!(page, "_Session:_ `{}`\n", summary.session_id);
                page.push_str(&summary.body);
                page.push('\n');
                self.write_wiki_page(
                    project,
                    &format!("summaries/{slug}"),
                    &summary.title,
                    &rel,
                    &page,
                )?;
                toc.push((summary.title.clone(), rel));
            }
            self.write_wiki_page(
                project,
                "summaries/index",
                "Summaries",
                "summaries/index.md",
                &index,
            )?;
            toc.push(("Summaries".into(), "summaries/index.md".into()));
        }

        // --- Providers (any prox-supported id seen in captures) ---
        let mut by_provider: BTreeMap<String, Vec<&CaptureEvent>> = BTreeMap::new();
        for e in &recent {
            let key = rivet_core::normalize_provider_id(&provider_key(e));
            by_provider.entry(key).or_default().push(e);
        }
        for (name, events) in &by_provider {
            let slug = slugify(name);
            let rel = format!("providers/{slug}.md");
            let title = format!("{name} captures");
            let mut body = format!("# {name}\n\n_{} recent events_\n\n", events.len());
            for e in events.iter().take(40) {
                let _ = writeln!(body, "- {}", format_event_line(e));
            }
            self.write_wiki_page(project, &format!("providers/{slug}"), &title, &rel, &body)?;
            toc.push((title, rel));
        }

        // --- Optional LLM overview via local proxy (at most hourly, only on new captures) ---
        if let Some(model) = cfg.wiki_model.as_deref() {
            let fingerprint = format!("{}:{}", totals.events, totals.tokens_in + totals.tokens_out);
            let last_fp = self.meta.job_cursor("wiki_llm_fp").ok().flatten();
            let last_at = self
                .meta
                .job_cursor("wiki_llm_at")
                .ok()
                .flatten()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(&s).ok())
                .map(|d| d.with_timezone(&Utc));
            let stale_hour = last_at.is_none_or(|t| Utc::now() - t > chrono::Duration::hours(1));
            let captures_changed = last_fp.as_deref() != Some(fingerprint.as_str());
            if captures_changed && stale_hour && totals.events > 0 {
                match self.generate_llm_overview(cfg, model, &recent, &totals).await {
                    Ok(markdown) => {
                        self.write_wiki_page(
                            project,
                            "overview-llm",
                            "LLM overview",
                            "overview-llm.md",
                            &markdown,
                        )?;
                        toc.push(("LLM overview".into(), "overview-llm.md".into()));
                        let _ = self.meta.set_job_cursor("wiki_llm_fp", &fingerprint);
                        let _ = self.meta.set_job_cursor("wiki_llm_at", &Utc::now().to_rfc3339());
                        info!(model, "wiki worker wrote LLM overview");
                    },
                    Err(err) => {
                        warn!(?err, "wiki LLM overview skipped (proxy/model unavailable)");
                    },
                }
            } else if self
                .paths
                .wiki_dir()
                .join(project)
                .join("overview-llm.md")
                .as_std_path()
                .is_file()
            {
                toc.push(("LLM overview".into(), "overview-llm.md".into()));
            }
        }

        // Stable TOC order: path sort so every file is listed once.
        toc.sort_by(|a, b| a.1.cmp(&b.1));
        toc.dedup_by(|a, b| a.1 == b.1);

        // --- README overview (last) with full table of contents ---
        let mut readme = String::new();
        readme.push_str("# Rivet project wiki\n\n");
        let _ = writeln!(
            readme,
            "_Auto-updated {} by the wiki worker_\n",
            Utc::now().format("%Y-%m-%d %H:%M UTC")
        );
        readme.push('\n');
        readme.push_str("## Capture snapshot\n\n");
        let _ = writeln!(readme, "- Events: **{}**", totals.events);
        let _ = writeln!(readme, "- Tokens in: **{}**", totals.tokens_in);
        let _ = writeln!(readme, "- Tokens out: **{}**", totals.tokens_out);
        let emb_n = self.ch.embedding_count(LEXICAL_SPACE).await.unwrap_or(0);
        let _ = writeln!(readme, "- Embeddings: **{emb_n}**\n");
        readme.push_str("## Table of contents\n\n");
        if toc.is_empty() {
            readme.push_str("_No pages yet — capture events to populate this wiki._\n");
        } else {
            for (title, rel) in &toc {
                let _ = writeln!(readme, "- [{title}]({rel})");
            }
        }
        readme.push_str("\n## Recent captures\n\n");
        for event in recent.iter().take(20) {
            let _ = writeln!(readme, "- {}", format_event_line(event));
        }
        self.write_wiki_page(project, "README", "Project overview", "README.md", &readme)?;

        self.meta.set_job_cursor("wiki", &Utc::now().to_rfc3339())?;
        debug!(project, pages = toc.len() + 1, "wiki worker upserted pages");
        Ok(())
    }

    async fn generate_llm_overview(
        &self,
        cfg: &RivetConfig,
        model: &str,
        recent: &[CaptureEvent],
        totals: &rivet_core::UsageTotals,
    ) -> Result<String> {
        let mut digest = String::new();
        let _ = writeln!(
            digest,
            "Totals: {} events, {} tokens in, {} tokens out.\n",
            totals.events, totals.tokens_in, totals.tokens_out
        );
        digest.push_str("\nRecent captures:\n");
        for e in recent.iter().take(40) {
            let _ = writeln!(digest, "{}", format_event_line(e));
        }
        let prompt =
            format!("{}\n\nCapture digest:\n{digest}", prompts::WIKI_EXTRACT_SYSTEM_PROMPT);
        let content = self
            .chat_prompt(cfg, model, "wiki-worker", prompts::WIKI_MERGE_SYSTEM_PROMPT, &prompt)
            .await?;
        Ok(format!(
            "# LLM overview\n\n_Generated {} via `{model}` through Rivet proxy_\n\n{content}\n",
            Utc::now().format("%Y-%m-%d %H:%M UTC")
        ))
    }

    fn write_wiki_page(
        &self,
        project: &str,
        id_suffix: &str,
        title: &str,
        relative: &str,
        body: &str,
    ) -> Result<()> {
        let abs = self.paths.wiki_dir().join(project).join(relative);
        if let Some(parent) = abs.as_std_path().parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(abs.as_std_path(), body)?;
        let page = WikiPageMeta {
            id: format!("{project}/{id_suffix}"),
            project_id: project.to_string(),
            title: title.to_string(),
            path: relative_wiki_path(&self.paths, abs.as_std_path()),
            updated_at: Utc::now().to_rfc3339(),
        };
        self.meta.upsert_wiki_page(&page)?;
        Ok(())
    }
}

#[derive(Debug)]
struct SchemaConstraint {
    name: &'static str,
    schema: Value,
}

struct GatheredExtract {
    claimed: ClaimedJob,
    summary: Option<SummaryMeta>,
}

fn stamp_extract_citations(
    patches: &mut [wiki_page::PagePatch],
    lead: &SummaryMeta,
    gathered: &[GatheredExtract],
) {
    let mut cite_summaries: Vec<&SummaryMeta> = vec![lead];
    for g in gathered {
        if let Some(s) = &g.summary {
            cite_summaries.push(s);
        }
    }
    let today = Utc::now().format("%Y-%m-%d").to_string();
    for patch in patches {
        for summary in &cite_summaries {
            patch.citations.push(wiki_page::PageCitation {
                id: summary.id.clone(),
                kind: "summary".into(),
                date: Some(today.clone()),
                note: Some(summary.title.clone()),
            });
            patch.sources.push(wiki_page::PageSource {
                id: summary.id.clone(),
                label: summary.title.clone(),
            });
            for eid in summary.event_ids.iter().take(4) {
                patch.citations.push(wiki_page::PageCitation {
                    id: eid.clone(),
                    kind: "event".into(),
                    date: None,
                    note: None,
                });
            }
        }
    }
}

fn payload_string_list(payload: &str, key: &str) -> Vec<String> {
    let value: Value = serde_json::from_str(payload).unwrap_or_else(|_| json!({}));
    value
        .get(key)
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(|s| s.trim().to_string()))
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

fn parse_recompile_response(
    slug: &str,
    page: &wiki_page::WikiPage,
    raw: &str,
) -> Option<wiki_page::PagePatch> {
    let trimmed = raw.trim();
    let start = trimmed.find('{')?;
    let end = trimmed.rfind('}')?;
    let json = &trimmed[start..=end];
    if let Ok(parsed) = serde_json::from_str::<wiki_schema::WikiRecompileResponse>(json) {
        return Some(wiki_page::PagePatch {
            action: wiki_page::WikiAction::Update,
            slug: slug.to_string(),
            title: page.title.clone(),
            summary: Some(parsed.summary).filter(|s| !s.trim().is_empty()),
            article: Some(parsed.article).filter(|s| !s.trim().is_empty()),
            article_patches: Vec::new(),
            history_entry: parsed
                .history_entry
                .or_else(|| Some("Recompiled oversized page.".into())),
            aliases: if parsed.aliases.is_empty() { page.aliases.clone() } else { parsed.aliases },
            tags: if parsed.tags.is_empty() { page.tags.clone() } else { parsed.tags },
            entities: if parsed.entities.is_empty() {
                page.entities.clone()
            } else {
                parsed.entities
            },
            related: if parsed.related.is_empty() { page.related.clone() } else { parsed.related },
            citations: page.citations.clone(),
            sources: page.sources.clone(),
            entity_type: None,
            allow_shrink: true,
        });
    }
    let v: Value = serde_json::from_str(json).ok()?;
    let string_list = |key: &str| -> Vec<String> {
        v.get(key)
            .and_then(|a| a.as_array())
            .map(|arr| arr.iter().filter_map(|x| x.as_str().map(str::to_string)).take(32).collect())
            .unwrap_or_default()
    };
    let aliases = string_list("aliases");
    let tags = string_list("tags");
    let entities = string_list("entities");
    let related = string_list("related");
    Some(wiki_page::PagePatch {
        action: wiki_page::WikiAction::Update,
        slug: slug.to_string(),
        title: v.get("title").and_then(|t| t.as_str()).unwrap_or(&page.title).to_string(),
        summary: v.get("summary").and_then(|t| t.as_str()).map(str::to_string),
        article: v.get("article").and_then(|t| t.as_str()).map(str::to_string),
        article_patches: Vec::new(),
        history_entry: v
            .get("history_entry")
            .and_then(|t| t.as_str())
            .map(str::to_string)
            .or_else(|| Some("Recompiled oversized page.".into())),
        aliases: if aliases.is_empty() { page.aliases.clone() } else { aliases },
        tags: if tags.is_empty() { page.tags.clone() } else { tags },
        entities: if entities.is_empty() { page.entities.clone() } else { entities },
        related: if related.is_empty() { page.related.clone() } else { related },
        citations: page.citations.clone(),
        sources: page.sources.clone(),
        entity_type: None,
        allow_shrink: true,
    })
}

fn format_event_line(event: &CaptureEvent) -> String {
    let preview = event
        .content
        .as_deref()
        .unwrap_or("")
        .chars()
        .take(140)
        .collect::<String>()
        .replace('|', "/")
        .replace('\n', " ");
    let provider = provider_key(event);
    let model = event.model.as_deref().unwrap_or("-");
    // Prefer explicit project_id; otherwise surface cwd so later classifiers have a signal.
    let place = event.project_id.as_deref().or(event.cwd.as_deref()).unwrap_or("-");
    format!(
        "`{}` · {} · `{}` · {} · {}/{} tok · {}",
        event.ts.format("%Y-%m-%d %H:%M"),
        provider,
        model,
        place,
        event.tokens_in,
        event.tokens_out,
        preview
    )
}

fn provider_key(event: &CaptureEvent) -> String {
    serde_json::to_value(event.provider)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_else(|| "other".into())
}

fn cluster_topics(events: &[CaptureEvent]) -> BTreeMap<String, Vec<&CaptureEvent>> {
    let mut buckets: HashMap<String, Vec<&CaptureEvent>> = HashMap::new();
    for event in events {
        let text = event.content.as_deref().unwrap_or("");
        let mut counts: HashMap<String, usize> = HashMap::new();
        for tok in text
            .split(|c: char| !c.is_alphanumeric())
            .filter(|t| t.len() > 4)
            .map(str::to_ascii_lowercase)
        {
            if STOP.contains(&tok.as_str()) || tok.chars().all(|c| c.is_ascii_digit()) {
                continue;
            }
            *counts.entry(tok).or_default() += 1;
        }
        let mut scored: Vec<(String, usize)> = counts.into_iter().collect();
        scored.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        let topic = scored.first().map_or_else(|| "general".into(), |(t, _)| t.clone());
        buckets.entry(topic).or_default().push(event);
    }
    let mut ordered: Vec<_> = buckets.into_iter().collect();
    ordered.sort_by_key(|a| std::cmp::Reverse(a.1.len()));
    ordered.into_iter().take(12).collect()
}

/// Split `type:Name`, `type/Name`, or `Name (type)` into optional type + display title.
fn parse_entity_label(raw: &str) -> (Option<String>, String) {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return (None, String::new());
    }
    if let Some((kind, name)) = trimmed.split_once(':') {
        let kind = kind.trim();
        let name = name.trim();
        if !kind.is_empty()
            && !name.is_empty()
            && kind.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            && kind.len() <= 32
        {
            return (Some(kind.to_string()), name.to_string());
        }
    }
    if let Some((kind, name)) = trimmed.split_once('/') {
        let kind = kind.trim();
        let name = name.trim();
        if !kind.is_empty()
            && !name.is_empty()
            && !kind.contains(' ')
            && kind.len() <= 32
            && name.split_whitespace().count() <= 6
        {
            return (Some(kind.to_string()), name.to_string());
        }
    }
    if let Some(open) = trimmed.rfind('(') {
        if trimmed.ends_with(')') {
            let name = trimmed[..open].trim();
            let kind = trimmed[open + 1..trimmed.len() - 1].trim();
            if !name.is_empty() && !kind.is_empty() && kind.len() <= 32 && !kind.contains(' ') {
                return (Some(kind.to_string()), name.to_string());
            }
        }
    }
    (None, trimmed.to_string())
}

fn slugify(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars().take(40) {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "topic".into()
    } else {
        trimmed
    }
}

const STOP: &[&str] = &[
    "about",
    "after",
    "again",
    "being",
    "between",
    "could",
    "every",
    "first",
    "their",
    "there",
    "these",
    "those",
    "through",
    "under",
    "where",
    "which",
    "while",
    "would",
    "should",
    "please",
    "thanks",
    "using",
    "with",
    "from",
    "this",
    "that",
    "have",
    "here",
    "your",
    "what",
    "when",
    "will",
    "into",
    "just",
    "like",
    "make",
    "need",
    "other",
    "some",
    "than",
    "then",
    "them",
    "content",
    "messages",
    "assistant",
    "system",
    "model",
    "tokens",
    "request",
    "response",
];

fn relative_wiki_path(paths: &RivetPaths, absolute: &std::path::Path) -> String {
    absolute
        .strip_prefix(paths.as_root().as_std_path())
        .unwrap_or(absolute)
        .to_string_lossy()
        .to_string()
}

fn batch_digest(events: &[CaptureEvent]) -> String {
    // Prefer user/assistant prose; demote pure tool noise to the end.
    let mut work = Vec::new();
    let mut tools = Vec::new();
    for (i, e) in events.iter().enumerate() {
        let line =
            format!("[#{:02} {}]\n{}", i + 1, e.ts.format("%Y-%m-%dT%H:%M"), format_event_line(e));
        if matches!(e.role, CaptureRole::Tool) {
            tools.push(line);
        } else {
            work.push(line);
        }
    }
    work.into_iter().chain(tools).collect::<Vec<_>>().join("\n\n---\n\n")
}

/// Strip meta openings ("This batch…") so summaries start with the work itself.
fn work_first_strip(body: &str) -> String {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let mut paras: Vec<&str> =
        trimmed.split("\n\n").map(str::trim).filter(|p| !p.is_empty()).collect();
    while let Some(first) = paras.first() {
        let lower = first.to_ascii_lowercase();
        let meta_open = lower.starts_with("this batch")
            || lower.starts_with("this leaf")
            || lower.starts_with("this branch")
            || lower.starts_with("this summary")
            || lower.starts_with("in this batch")
            || lower.starts_with("in this leaf")
            || lower.starts_with("summary of")
            || lower.starts_with("the batch")
            || lower.starts_with("the following batch")
            || lower.contains("messages in this batch")
            || lower.contains("leaves in this branch");
        if meta_open {
            paras.remove(0);
            continue;
        }
        break;
    }
    if paras.is_empty() {
        trimmed.to_string()
    } else {
        paras.join("\n\n")
    }
}

fn fallback_bullet_digest(events: &[CaptureEvent]) -> String {
    let mut body = String::from("## Recent activity\n\n");
    for event in events.iter().rev().take(12) {
        let _ = writeln!(body, "- {}", format_event_line(event));
    }
    body
}

fn payload_str(payload: &str, key: &str) -> Result<String> {
    payload_str_opt(payload, key).ok_or_else(|| anyhow!("job payload missing `{key}`"))
}

fn payload_str_opt(payload: &str, key: &str) -> Option<String> {
    let value: Value = serde_json::from_str(payload).unwrap_or_else(|_| json!({}));
    value
        .get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn uuid_like() -> String {
    let nanos = Utc::now().timestamp_nanos_opt().unwrap_or(0).cast_unsigned();
    format!("{:x}", nanos ^ u64::from(std::process::id()))
}

#[cfg(test)]
mod compact_tests {
    use super::work_first_strip;

    #[test]
    fn strips_batch_meta_openings() {
        let raw = "This batch covers three tool calls.\n\nThe auth middleware now rejects expired tokens.\n\nFollow-up: add tests.";
        let out = work_first_strip(raw);
        assert!(out.starts_with("The auth middleware"));
        assert!(!out.to_ascii_lowercase().contains("this batch"));
    }

    #[test]
    fn keeps_body_when_no_meta_opening() {
        let raw = "Implemented soft→wire remapping for session ids.";
        assert_eq!(work_first_strip(raw), raw);
    }
}
