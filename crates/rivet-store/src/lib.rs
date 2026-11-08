//! Persistence layer — `ClickHouse` for traffic, JSON files for meta.

mod clickhouse;
mod meta;
mod redacting;

use anyhow::Result;
use async_trait::async_trait;
use rivet_core::{
    conversations_from_events, ConversationSummary, RivetPaths, TrafficEvent, UsageTotals,
};
use std::sync::Arc;
use tracing::info;

pub use clickhouse::{ClickHouseTrafficStore, TRAFFIC_EVENTS_DDL};
pub use meta::{EmbeddingRow, MetaStore, QuotaSnapshotInsert, QuotaSnapshotRow, WikiPageMeta};
pub use redacting::RedactingStore;

#[async_trait]
pub trait TrafficStore: Send + Sync {
    async fn insert_event(&self, event: &TrafficEvent) -> Result<()>;
    async fn insert_batch(&self, events: &[TrafficEvent]) -> Result<()>;
    async fn recent(&self, limit: u32) -> Result<Vec<TrafficEvent>>;
    async fn search_keyword(&self, query: &str, limit: u32) -> Result<Vec<TrafficEvent>>;
    async fn get_by_ids(&self, ids: &[String]) -> Result<Vec<TrafficEvent>>;
    async fn usage_totals(&self) -> Result<UsageTotals>;
    async fn export_all(&self) -> Result<Vec<TrafficEvent>>;

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
    ) -> Result<Vec<TrafficEvent>> {
        let id = conversation_id.trim();
        if id.is_empty() {
            return Ok(Vec::new());
        }
        if let Some(event_id) = id.strip_prefix("event:") {
            return self.get_by_ids(&[event_id.to_string()]).await;
        }
        let events = self.recent(limit.saturating_mul(8).clamp(100, 5000)).await?;
        let mut matched: Vec<TrafficEvent> = events
            .into_iter()
            .filter(|e| e.conversation_id() == id)
            .collect();
        matched.sort_by(|a, b| a.ts.cmp(&b.ts));
        matched.truncate(limit.max(1) as usize);
        Ok(matched)
    }

    /// Keyword search projected to conversation summaries.
    async fn search_conversations(
        &self,
        query: &str,
        limit: u32,
    ) -> Result<Vec<ConversationSummary>> {
        let events = self
            .search_keyword(query, limit.saturating_mul(8).clamp(50, 2000))
            .await?;
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
        Ok(Self {
            meta: Arc::new(MetaStore::open(paths)?),
        })
    }

    /// ClickHouse-only traffic (redacted on write). Requires a reachable URL.
    pub fn traffic_store(&self) -> Result<Arc<dyn TrafficStore>> {
        self.traffic_store_with_clickhouse(ClickHouseTrafficStore::from_env_url())
    }

    pub fn traffic_store_with_clickhouse(
        &self,
        clickhouse_url: Option<String>,
    ) -> Result<Arc<dyn TrafficStore>> {
        let url = clickhouse_url.ok_or_else(|| {
            anyhow::anyhow!(
                "ClickHouse required: set RIVET_CLICKHOUSE_URL or ship the clickhouse sidecar"
            )
        })?;
        let ch = ClickHouseTrafficStore::new(&url)?;
        info!(%url, "ClickHouse traffic store enabled");
        Ok(Arc::new(RedactingStore::new(Arc::new(ch))))
    }
}
