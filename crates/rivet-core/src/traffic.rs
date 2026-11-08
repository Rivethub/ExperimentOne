use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    Claude,
    Codex,
    OpenAi,
    Gemini,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrafficRole {
    System,
    User,
    Assistant,
    Tool,
    Unknown,
}

/// One captured unit of proxy traffic. Safe to export (no credentials).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrafficEvent {
    pub id: Uuid,
    pub ts: DateTime<Utc>,
    pub provider: ProviderKind,
    pub account_label: Option<String>,
    pub model: Option<String>,
    pub session_id: Option<String>,
    pub project_id: Option<String>,
    pub request_id: Option<String>,
    pub role: TrafficRole,
    pub content: Option<String>,
    pub tokens_in: u32,
    pub tokens_out: u32,
    pub latency_ms: Option<u64>,
    pub status_code: Option<u16>,
    /// Relative path under blobs/ when body was spilled to disk.
    pub body_ref: Option<String>,
}

impl TrafficEvent {
    pub fn new(provider: ProviderKind) -> Self {
        Self {
            id: Uuid::new_v4(),
            ts: Utc::now(),
            provider,
            account_label: None,
            model: None,
            session_id: None,
            project_id: None,
            request_id: None,
            role: TrafficRole::Unknown,
            content: None,
            tokens_in: 0,
            tokens_out: 0,
            latency_ms: None,
            status_code: None,
            body_ref: None,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UsageTotals {
    pub events: u64,
    pub tokens_in: u64,
    pub tokens_out: u64,
}

/// Manifest inside a `.rivetbag` export. Credentials are never included.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportManifest {
    pub schema_version: u32,
    pub created_at: DateTime<Utc>,
    pub event_count: u64,
    pub includes_embeddings: bool,
    pub includes_wiki: bool,
    pub note: Option<String>,
}

impl ExportManifest {
    pub const SCHEMA_VERSION: u32 = 1;
}
