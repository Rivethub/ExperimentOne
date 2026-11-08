//! TrafficStore wrapper that redacts content before persistence.

use anyhow::Result;
use async_trait::async_trait;
use rivet_core::{redact_event, TrafficEvent, UsageTotals};
use std::sync::Arc;

use crate::TrafficStore;

pub struct RedactingStore {
    inner: Arc<dyn TrafficStore>,
}

impl RedactingStore {
    pub fn new(inner: Arc<dyn TrafficStore>) -> Self {
        Self { inner }
    }
}

#[async_trait]
impl TrafficStore for RedactingStore {
    async fn insert_event(&self, event: &TrafficEvent) -> Result<()> {
        let mut e = event.clone();
        redact_event(&mut e);
        self.inner.insert_event(&e).await
    }

    async fn insert_batch(&self, events: &[TrafficEvent]) -> Result<()> {
        let mut owned: Vec<TrafficEvent> = events.to_vec();
        for e in &mut owned {
            redact_event(e);
        }
        self.inner.insert_batch(&owned).await
    }

    async fn recent(&self, limit: u32) -> Result<Vec<TrafficEvent>> {
        self.inner.recent(limit).await
    }

    async fn search_keyword(&self, query: &str, limit: u32) -> Result<Vec<TrafficEvent>> {
        self.inner.search_keyword(query, limit).await
    }

    async fn get_by_ids(&self, ids: &[String]) -> Result<Vec<TrafficEvent>> {
        self.inner.get_by_ids(ids).await
    }

    async fn usage_totals(&self) -> Result<UsageTotals> {
        self.inner.usage_totals().await
    }

    async fn export_all(&self) -> Result<Vec<TrafficEvent>> {
        // Re-redact on export as defense in depth.
        let mut events = self.inner.export_all().await?;
        for e in &mut events {
            redact_event(e);
        }
        Ok(events)
    }
}
