//! Process-local live event bus (SSE / desktop refresh).

use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

/// Something changed that UIs may want to refresh.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum LiveEvent {
    /// Wiki filesystem / index revision bumped.
    Wiki { revision: u64 },
    /// Capture events were ingested.
    Capture { count: u64 },
    /// Periodic keep-alive for SSE clients.
    Heartbeat,
}

/// Cheap snapshot for long-poll / Tauri watchers (no stream required).
#[derive(
    Debug,
    Clone,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Default,
    utoipa::ToSchema,
    schemars::JsonSchema,
)]
pub struct LiveCursor {
    pub wiki_revision: u64,
    pub capture_events: u64,
    pub observed_at: String,
}

/// Fan-out bus shared by API, ingest, and workers.
#[derive(Clone, Debug)]
pub struct LiveBus {
    tx: broadcast::Sender<LiveEvent>,
}

impl LiveBus {
    #[must_use]
    pub fn new(capacity: usize) -> Self {
        let (tx, _) = broadcast::channel(capacity.max(16));
        Self { tx }
    }

    pub fn publish(&self, event: LiveEvent) {
        let _ = self.tx.send(event);
    }

    #[must_use]
    pub fn subscribe(&self) -> broadcast::Receiver<LiveEvent> {
        self.tx.subscribe()
    }
}
