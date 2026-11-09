//! Persistence layer — `ClickHouse` for captures + embeddings, NATS `JetStream` for
//! jobs, JSON files for meta.

#![recursion_limit = "256"]

mod clickhouse;
mod hybrid;
pub mod jobs;
mod meta;
mod migrations;
mod nats_jobs;
mod redacting;

use anyhow::Result;
use async_trait::async_trait;
use rivet_core::{
    conversations_from_events, CaptureEvent, ConversationSummary, RivetPaths, UsageTotals,
};
use std::sync::Arc;
use tracing::info;

pub use clickhouse::{
    ClickHouseCaptureStore, EmbeddingSearchHit, CAPTURE_EVENTS_DDL, EMBEDDINGS_DDL,
};
pub use hybrid::{
    fuse_event_id_arms, fuse_event_id_arms_boosted, hybrid_fetch_limit, prefer_lexical_query,
};
pub use jobs::{
    JobStatus, QueueStats, WorkerJob, WorkerRole, PRIORITY_BACKFILL, PRIORITY_CLASSIFY,
    PRIORITY_EMBED, PRIORITY_LIVE_COMPACT, PRIORITY_WIKI, TASK_CLASSIFY_SESSION,
    TASK_COMPACT_SESSION, TASK_CONSOLIDATE_WIKI, TASK_EMBED_EVENT, TASK_EMBED_REMOTE_EVENT,
    TASK_ENQUEUE_IDLE, TASK_ENQUEUE_REMOTE_REEMBED, TASK_ENQUEUE_UNEMBEDDED,
    TASK_ENQUEUE_WIKI_BACKFILL, TASK_EXTRACT_WIKI, TASK_RECOMPILE_WIKI, TASK_SUGGEST_TAGS,
    TASK_SYNTHESIZE_TOOL, TASK_UPSERT_TOPICS,
};
pub use meta::{
    can_nest_under, topic_depth, EnrichmentEvent, LineageExpand, MetaStore, PlacementBy,
    QuotaSnapshotInsert, QuotaSnapshotRow, SessionBinding, SummaryKind, SummaryMeta, TagSuggestion,
    TidyProposal, TopicMeta, WikiPageMeta, COMPACT_PIPELINE_VERSION, MAX_TOPIC_DEPTH,
};
pub use migrations::{run as run_clickhouse_migrations, MIGRATIONS};
pub use nats_jobs::{ClaimedJob, NatsJobStore, STREAM_DEAD, STREAM_JOBS};
pub use redacting::RedactingStore;

#[async_trait]
pub trait CaptureStore: Send + Sync {
    async fn insert_event(&self, event: &CaptureEvent) -> Result<()>;
    async fn insert_batch(&self, events: &[CaptureEvent]) -> Result<()>;
    async fn recent(&self, limit: u32) -> Result<Vec<CaptureEvent>>;
    async fn search_keyword(&self, query: &str, limit: u32) -> Result<Vec<CaptureEvent>>;
    async fn get_by_ids(&self, ids: &[String]) -> Result<Vec<CaptureEvent>>;
    async fn usage_totals(&self) -> Result<UsageTotals>;
    async fn export_all(&self) -> Result<Vec<CaptureEvent>>;

    /// Events for the given conversation ids (session ids or `event:{uuid}`), chronological.
    ///
    /// Default walks `conversation_events` per id. Stores may override for a bulk query.
    async fn export_for_conversations(
        &self,
        conversation_ids: &[String],
    ) -> Result<Vec<CaptureEvent>> {
        use std::collections::HashSet;

        let mut out = Vec::new();
        let mut seen = HashSet::new();
        for raw in conversation_ids {
            let id = raw.trim();
            if id.is_empty() {
                continue;
            }
            for event in self.conversation_events(id, 50_000).await? {
                if seen.insert(event.id) {
                    out.push(event);
                }
            }
        }
        out.sort_by_key(|event| event.ts);
        Ok(out)
    }

    /// Historical conversations grouped by session (newest first).
    async fn list_conversations(&self, limit: u32) -> Result<Vec<ConversationSummary>> {
        let events = self.recent(limit.saturating_mul(8).clamp(50, 2000)).await?;
        Ok(conversations_from_events(&events, limit.max(1)))
    }

    /// Events for one conversation, chronological.
    async fn conversation_events(
        &self,
        conversation_id: &str,
        limit: u32,
    ) -> Result<Vec<CaptureEvent>> {
        let id = conversation_id.trim();
        if id.is_empty() {
            return Ok(Vec::new());
        }
        if let Some(event_id) = id.strip_prefix("event:") {
            return self.get_by_ids(&[event_id.to_string()]).await;
        }
        let events = self.recent(limit.saturating_mul(8).clamp(100, 5000)).await?;
        let mut matched: Vec<CaptureEvent> =
            events.into_iter().filter(|e| e.conversation_id() == id).collect();
        matched.sort_by_key(|event| event.ts);
        matched.truncate(limit.max(1) as usize);
        Ok(matched)
    }

    /// Keyword search projected to conversation summaries.
    async fn search_conversations(
        &self,
        query: &str,
        limit: u32,
    ) -> Result<Vec<ConversationSummary>> {
        let events = self.search_keyword(query, limit.saturating_mul(8).clamp(50, 2000)).await?;
        Ok(conversations_from_events(&events, limit.max(1)))
    }
}

/// Open local stores under Application Support.
#[derive(Debug)]
pub struct LocalStores {
    pub meta: Arc<MetaStore>,
}

impl LocalStores {
    pub fn open(paths: &RivetPaths) -> Result<Self> {
        paths.ensure()?;
        Ok(Self { meta: Arc::new(MetaStore::open(paths)?) })
    }

    /// `ClickHouse` captures (redacted on write) plus the raw CH client for embeddings.
    pub fn capture_store(&self) -> Result<(Arc<dyn CaptureStore>, Arc<ClickHouseCaptureStore>)> {
        self.capture_store_with_clickhouse(ClickHouseCaptureStore::from_env_url())
    }

    pub fn capture_store_with_clickhouse(
        &self,
        clickhouse_url: Option<String>,
    ) -> Result<(Arc<dyn CaptureStore>, Arc<ClickHouseCaptureStore>)> {
        let url = clickhouse_url.ok_or_else(|| {
            anyhow::anyhow!(
                "ClickHouse required: set RIVET_CLICKHOUSE_URL or ship the clickhouse sidecar"
            )
        })?;
        let ch = Arc::new(ClickHouseCaptureStore::new(&url)?);
        info!(%url, "ClickHouse captures store enabled");
        Ok((Arc::new(RedactingStore::new(ch.clone())), ch))
    }
}
