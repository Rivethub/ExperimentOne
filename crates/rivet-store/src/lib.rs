//! Persistence layer.
//!
//! Local MVP writes traffic into SQLite with a ClickHouse-shaped schema so we can
//! dual-write / migrate to a bundled ClickHouse sidecar without changing callers.
//! Enterprise deployments point the same trait at ClickHouse.

mod clickhouse;
mod meta;
mod redacting;
mod traffic_sqlite;

use anyhow::Result;
use async_trait::async_trait;
use rivet_core::{RivetPaths, TrafficEvent, UsageTotals};
use std::sync::Arc;
use tracing::info;

pub use clickhouse::{ClickHouseTrafficStore, DualWriteStore, TRAFFIC_EVENTS_DDL};
pub use meta::{EmbeddingRow, MetaStore, WikiPageMeta};
pub use redacting::RedactingStore;
pub use traffic_sqlite::SqliteTrafficStore;

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
    pub traffic: SqliteTrafficStore,
}

impl LocalStores {
    pub fn open(paths: &RivetPaths) -> Result<Self> {
        paths.ensure()?;
        Ok(Self {
            meta: Arc::new(MetaStore::open(paths)?),
            traffic: SqliteTrafficStore::open(paths)?,
        })
    }

    /// SQLite primary, optional ClickHouse dual-write, always redacted on write.
    ///
    /// `clickhouse_url` — when set (bundled sidecar or `RIVET_CLICKHOUSE_URL`),
    /// inserts are dual-written. Reads stay on SQLite.
    pub fn traffic_store(&self) -> Arc<dyn TrafficStore> {
        self.traffic_store_with_clickhouse(ClickHouseTrafficStore::from_env_url())
    }

    pub fn traffic_store_with_clickhouse(
        &self,
        clickhouse_url: Option<String>,
    ) -> Arc<dyn TrafficStore> {
        let primary: Arc<dyn TrafficStore> = Arc::new(self.traffic.clone());
        let secondary: Option<Arc<dyn TrafficStore>> = clickhouse_url.and_then(|url| {
            match ClickHouseTrafficStore::new(&url) {
                Ok(ch) => {
                    info!(%url, "ClickHouse dual-write enabled");
                    Some(Arc::new(ch) as Arc<dyn TrafficStore>)
                }
                Err(err) => {
                    tracing::warn!(?err, "invalid ClickHouse URL — SQLite only");
                    None
                }
            }
        });
        let dual = Arc::new(DualWriteStore::new(primary, secondary));
        Arc::new(RedactingStore::new(dual))
    }
}
