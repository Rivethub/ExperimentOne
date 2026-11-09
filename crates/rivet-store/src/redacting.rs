//! `CaptureStore` wrapper that redacts content before persistence.

use anyhow::Result;
use async_trait::async_trait;
use rivet_core::{redact_event, ConversationSummary, CaptureEvent, UsageTotals};
use std::sync::Arc;

use crate::CaptureStore;

pub struct RedactingStore {
    inner: Arc<dyn CaptureStore>,
}

impl std::fmt::Debug for RedactingStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RedactingStore").finish_non_exhaustive()
    }
}

impl RedactingStore {
    pub fn new(inner: Arc<dyn CaptureStore>) -> Self {
        Self { inner }
    }
}

#[async_trait]
impl CaptureStore for RedactingStore {
    async fn insert_event(&self, event: &CaptureEvent) -> Result<()> {
        let mut e = event.clone();
        redact_event(&mut e);
        self.inner.insert_event(&e).await
    }

    async fn insert_batch(&self, events: &[CaptureEvent]) -> Result<()> {
        let mut owned: Vec<CaptureEvent> = events.to_vec();
        for e in &mut owned {
            redact_event(e);
        }
        self.inner.insert_batch(&owned).await
    }

    async fn recent(&self, limit: u32) -> Result<Vec<CaptureEvent>> {
        self.inner.recent(limit).await
    }

    async fn search_keyword(&self, query: &str, limit: u32) -> Result<Vec<CaptureEvent>> {
        self.inner.search_keyword(query, limit).await
    }

    async fn get_by_ids(&self, ids: &[String]) -> Result<Vec<CaptureEvent>> {
        self.inner.get_by_ids(ids).await
    }

    async fn usage_totals(&self) -> Result<UsageTotals> {
        self.inner.usage_totals().await
    }

    async fn export_all(&self) -> Result<Vec<CaptureEvent>> {
        // Re-redact on export as defense in depth.
        let mut events = self.inner.export_all().await?;
        for e in &mut events {
            redact_event(e);
        }
        Ok(events)
    }

    async fn export_for_conversations(
        &self,
        conversation_ids: &[String],
    ) -> Result<Vec<CaptureEvent>> {
        let mut events = self.inner.export_for_conversations(conversation_ids).await?;
        for e in &mut events {
            redact_event(e);
        }
        Ok(events)
    }

    async fn list_conversations(&self, limit: u32) -> Result<Vec<ConversationSummary>> {
        self.inner.list_conversations(limit).await
    }

    async fn conversation_events(
        &self,
        conversation_id: &str,
        limit: u32,
    ) -> Result<Vec<CaptureEvent>> {
        self.inner.conversation_events(conversation_id, limit).await
    }

    async fn search_conversations(
        &self,
        query: &str,
        limit: u32,
    ) -> Result<Vec<ConversationSummary>> {
        self.inner.search_conversations(query, limit).await
    }
}
