//! Persistence layer — ClickHouse for traffic, JSON files for meta.

mod clickhouse;
mod meta;
mod redacting;

use anyhow::Result;
use async_trait::async_trait;
use rivet_core::{RivetPaths, TrafficEvent, UsageTotals};
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
}

/// Open local stores under Application Support.
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
