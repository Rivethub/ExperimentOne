//! Worker job types shared by the NATS `JetStream` job plane.
//!
//! Enqueue/claim/ack live in [`crate::nats_jobs`]. Payloads and task constants
//! stay here so ingest, API, and workers share one schema.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Worker role — each process/task loop only claims its task set.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerRole {
    Embed,
    Compact,
    Wiki,
    /// Desktop default: run every role in-process as isolated loops.
    All,
}

impl WorkerRole {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Embed => "embed",
            Self::Compact => "compact",
            Self::Wiki => "wiki",
            Self::All => "all",
        }
    }

    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "embed" => Self::Embed,
            "compact" => Self::Compact,
            "wiki" => Self::Wiki,
            _ => Self::All,
        }
    }

    pub fn from_env() -> Self {
        std::env::var("RIVET_WORKER_ROLE").ok().as_deref().map_or(Self::All, Self::parse)
    }

    /// Task identifiers this role is allowed to claim.
    pub const fn tasks(self) -> &'static [&'static str] {
        match self {
            Self::Embed => &[TASK_EMBED_EVENT, TASK_ENQUEUE_UNEMBEDDED],
            Self::Compact => &[
                TASK_CLASSIFY_SESSION,
                TASK_COMPACT_SESSION,
                TASK_ENQUEUE_IDLE,
                TASK_SYNTHESIZE_TOOL,
                TASK_SUGGEST_TAGS,
            ],
            Self::Wiki => &[
                TASK_UPSERT_TOPICS,
                TASK_EXTRACT_WIKI,
                TASK_ENQUEUE_WIKI_BACKFILL,
                TASK_CONSOLIDATE_WIKI,
                TASK_RECOMPILE_WIKI,
            ],
            Self::All => &[
                TASK_EMBED_EVENT,
                TASK_ENQUEUE_UNEMBEDDED,
                TASK_CLASSIFY_SESSION,
                TASK_COMPACT_SESSION,
                TASK_ENQUEUE_IDLE,
                TASK_SYNTHESIZE_TOOL,
                TASK_SUGGEST_TAGS,
                TASK_UPSERT_TOPICS,
                TASK_EXTRACT_WIKI,
                TASK_ENQUEUE_WIKI_BACKFILL,
                TASK_CONSOLIDATE_WIKI,
                TASK_RECOMPILE_WIKI,
            ],
        }
    }
}

pub const TASK_EMBED_EVENT: &str = "embed-event";
pub const TASK_ENQUEUE_UNEMBEDDED: &str = "enqueue-unembedded";
pub const TASK_CLASSIFY_SESSION: &str = "classify-session";
pub const TASK_COMPACT_SESSION: &str = "compact-session";
pub const TASK_ENQUEUE_IDLE: &str = "enqueue-idle";
pub const TASK_SYNTHESIZE_TOOL: &str = "synthesize-tool";
pub const TASK_SUGGEST_TAGS: &str = "suggest-tags";
pub const TASK_UPSERT_TOPICS: &str = "upsert-topics";
pub const TASK_EXTRACT_WIKI: &str = "extract-wiki";
pub const TASK_ENQUEUE_WIKI_BACKFILL: &str = "enqueue-wiki-backfill";
pub const TASK_CONSOLIDATE_WIKI: &str = "consolidate-wiki";
pub const TASK_RECOMPILE_WIKI: &str = "recompile-wiki";

pub const PRIORITY_LIVE_COMPACT: i16 = 0;
pub const PRIORITY_EMBED: i16 = 3;
pub const PRIORITY_CLASSIFY: i16 = 4;
pub const PRIORITY_WIKI: i16 = 5;
pub const PRIORITY_BACKFILL: i16 = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobStatus {
    Pending,
    Running,
    Done,
    Failed,
    Dead,
}

impl JobStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Dead => "dead",
        }
    }

    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "running" => Self::Running,
            "done" => Self::Done,
            "failed" => Self::Failed,
            "dead" => Self::Dead,
            _ => Self::Pending,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerJob {
    pub job_key: String,
    pub task: String,
    pub priority: i16,
    pub run_at: DateTime<Utc>,
    pub status: JobStatus,
    pub payload: String,
    pub attempts: u16,
    pub max_attempts: u16,
    pub worker_id: Option<String>,
    pub lease_until: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
    pub pipeline_version: u16,
    pub updated_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}

impl WorkerJob {
    pub fn new_pending(
        task: &str,
        job_key: &str,
        payload: impl Into<String>,
        priority: i16,
    ) -> Self {
        let now = Utc::now();
        Self {
            job_key: job_key.to_string(),
            task: task.to_string(),
            priority,
            run_at: now,
            status: JobStatus::Pending,
            payload: payload.into(),
            attempts: 0,
            max_attempts: 5,
            worker_id: None,
            lease_until: None,
            last_error: None,
            pipeline_version: 1,
            updated_at: now,
            created_at: now,
        }
    }

    pub fn embed_event(event_id: &str) -> Self {
        Self::new_pending(
            TASK_EMBED_EVENT,
            &format!("embed-event:{event_id}"),
            serde_json::json!({ "event_id": event_id }).to_string(),
            PRIORITY_EMBED,
        )
    }

    pub fn classify_session(session_id: &str) -> Self {
        Self::new_pending(
            TASK_CLASSIFY_SESSION,
            &format!("classify-session:{session_id}"),
            serde_json::json!({ "session_id": session_id }).to_string(),
            PRIORITY_CLASSIFY,
        )
    }

    pub fn compact_session(session_id: &str) -> Self {
        Self::compact_session_reason(session_id, "idle")
    }

    pub fn compact_session_reason(session_id: &str, reason: &str) -> Self {
        let reason = match reason {
            "stale" | "threshold" | "pipeline" | "idle" => reason,
            _ => "idle",
        };
        let priority = if reason == "stale" || reason == "pipeline" {
            PRIORITY_BACKFILL
        } else {
            PRIORITY_LIVE_COMPACT
        };
        Self::new_pending(
            TASK_COMPACT_SESSION,
            &format!("compact-session:{session_id}"),
            serde_json::json!({ "session_id": session_id, "reason": reason }).to_string(),
            priority,
        )
    }

    pub fn upsert_topics() -> Self {
        Self::new_pending(TASK_UPSERT_TOPICS, "upsert-topics", "{}", PRIORITY_WIKI)
    }

    pub fn extract_wiki_summary(summary_id: &str) -> Self {
        Self::extract_wiki_summary_routes(summary_id, &[])
    }

    /// Per-summary wiki extract with coalesce route keys (e.g. `session:…`, `topic:…`).
    pub fn extract_wiki_summary_routes(summary_id: &str, routes: &[String]) -> Self {
        Self::new_pending(
            TASK_EXTRACT_WIKI,
            &format!("extract-wiki:{summary_id}"),
            serde_json::json!({
                "summary_id": summary_id,
                "routes": routes,
            })
            .to_string(),
            PRIORITY_WIKI,
        )
    }

    pub fn enqueue_unembedded() -> Self {
        Self::new_pending(TASK_ENQUEUE_UNEMBEDDED, "enqueue-unembedded", "{}", PRIORITY_BACKFILL)
    }

    pub fn enqueue_idle() -> Self {
        Self::new_pending(TASK_ENQUEUE_IDLE, "enqueue-idle", "{}", PRIORITY_BACKFILL)
    }

    #[must_use]
    pub const fn with_run_at(mut self, run_at: DateTime<Utc>) -> Self {
        self.run_at = run_at;
        self
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct QueueStats {
    pub pending: u64,
    pub running: u64,
    pub done: u64,
    pub failed: u64,
    pub dead: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roles_partition_tasks() {
        assert!(WorkerRole::Embed.tasks().contains(&TASK_EMBED_EVENT));
        assert!(!WorkerRole::Embed.tasks().contains(&TASK_EXTRACT_WIKI));
        assert!(WorkerRole::Compact.tasks().contains(&TASK_COMPACT_SESSION));
        assert!(WorkerRole::Wiki.tasks().contains(&TASK_UPSERT_TOPICS));
        assert_eq!(WorkerRole::All.tasks().len(), 12);
    }

    #[test]
    fn embed_job_key_is_stable() {
        let job = WorkerJob::embed_event("abc");
        assert_eq!(job.job_key, "embed-event:abc");
        assert_eq!(job.task, TASK_EMBED_EVENT);
        assert_eq!(job.priority, PRIORITY_EMBED);
        assert_eq!(job.status, JobStatus::Pending);
    }

    #[test]
    fn extract_wiki_summary_job_key() {
        let job = WorkerJob::extract_wiki_summary("sum-1");
        assert_eq!(job.job_key, "extract-wiki:sum-1");
        assert_eq!(job.task, TASK_EXTRACT_WIKI);
        assert!(job.payload.contains("sum-1"));
    }

    #[test]
    fn extract_wiki_summary_includes_routes() {
        let job = WorkerJob::extract_wiki_summary_routes(
            "sum-1",
            &["session:abc".into(), "topic:auth".into()],
        );
        assert!(job.payload.contains("session:abc"));
        assert!(job.payload.contains("topic:auth"));
    }
}
