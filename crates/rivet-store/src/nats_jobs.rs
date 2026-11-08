//! NATS `JetStream`-backed worker job plane (`WorkQueue`).
//!
//! Desktop and production share the same subjects and ack semantics. Local
//! `nats-server` is a sidecar; prod sets `RIVET_NATS_URL` to a `JetStream` cluster.

use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use async_nats::jetstream::{
    self,
    consumer::{self, pull, PullConsumer},
    stream::{self, RetentionPolicy, StorageType},
    AckKind, Message,
};
use async_nats::{HeaderMap, HeaderValue};
use bytes::Bytes;
use chrono::Utc;
use futures::StreamExt;
use tracing::{debug, info, warn};

use crate::jobs::{JobStatus, QueueStats, WorkerJob, WorkerRole};

pub const STREAM_JOBS: &str = "RIVET_JOBS";
pub const STREAM_DEAD: &str = "RIVET_JOBS_DEAD";
pub const SUBJECT_PREFIX: &str = "rivet.jobs";
/// Outside `rivet.jobs.>` so it does not overlap the `WorkQueue` stream.
pub const SUBJECT_DEAD: &str = "rivet.dead.jobs";

/// Job plus the `JetStream` message needed to ack / nak.
pub struct ClaimedJob {
    pub job: WorkerJob,
    message: Message,
}

impl std::fmt::Debug for ClaimedJob {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClaimedJob").field("job", &self.job).finish_non_exhaustive()
    }
}

impl ClaimedJob {
    pub fn into_parts(self) -> (WorkerJob, Message) {
        (self.job, self.message)
    }
}

#[derive(Clone)]
pub struct NatsJobStore {
    js: jetstream::Context,
}

impl std::fmt::Debug for NatsJobStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NatsJobStore").finish_non_exhaustive()
    }
}

fn box_err(err: impl std::fmt::Display) -> anyhow::Error {
    anyhow!("{err}")
}

impl NatsJobStore {
    pub async fn connect(url: &str) -> Result<Self> {
        let client =
            async_nats::connect(url).await.with_context(|| format!("connect NATS at {url}"))?;
        let js = jetstream::new(client);
        Ok(Self { js })
    }

    pub fn from_env_url() -> Option<String> {
        std::env::var("RIVET_NATS_URL").ok().filter(|s| !s.trim().is_empty())
    }

    pub fn subject_for_task(task: &str) -> String {
        format!("{SUBJECT_PREFIX}.{task}")
    }

    pub async fn ensure_schema(&self) -> Result<()> {
        self.js
            .get_or_create_stream(stream::Config {
                name: STREAM_JOBS.into(),
                subjects: vec![format!("{SUBJECT_PREFIX}.>")],
                retention: RetentionPolicy::WorkQueue,
                storage: StorageType::File,
                duplicate_window: Duration::from_secs(120),
                max_bytes: 2 * 1024 * 1024 * 1024,
                ..Default::default()
            })
            .await
            .map_err(box_err)
            .context("create RIVET_JOBS stream")?;

        self.js
            .get_or_create_stream(stream::Config {
                name: STREAM_DEAD.into(),
                subjects: vec![SUBJECT_DEAD.into()],
                retention: RetentionPolicy::Limits,
                storage: StorageType::File,
                max_messages: 10_000,
                max_age: Duration::from_hours(14 * 24),
                ..Default::default()
            })
            .await
            .map_err(box_err)
            .context("create RIVET_JOBS_DEAD stream")?;

        for role in [WorkerRole::Embed, WorkerRole::Compact, WorkerRole::Wiki] {
            self.ensure_role_consumer(role).await?;
        }
        info!("NATS JetStream job streams ready");
        Ok(())
    }

    async fn ensure_role_consumer(&self, role: WorkerRole) -> Result<String> {
        let name = format!("rivet-{}", role.as_str());
        let filters: Vec<String> = role.tasks().iter().map(|t| Self::subject_for_task(t)).collect();
        let stream =
            self.js.get_stream(STREAM_JOBS).await.map_err(box_err).context("get RIVET_JOBS")?;
        let cfg = if filters.len() == 1 {
            pull::Config {
                durable_name: Some(name.clone()),
                filter_subject: filters[0].clone(),
                ack_policy: consumer::AckPolicy::Explicit,
                ack_wait: Duration::from_secs(90),
                max_deliver: 8,
                max_ack_pending: 256,
                ..Default::default()
            }
        } else {
            pull::Config {
                durable_name: Some(name.clone()),
                filter_subject: String::new(),
                filter_subjects: filters,
                ack_policy: consumer::AckPolicy::Explicit,
                ack_wait: Duration::from_secs(90),
                max_deliver: 8,
                max_ack_pending: 256,
                ..Default::default()
            }
        };
        let _: PullConsumer = stream
            .get_or_create_consumer(&name, cfg)
            .await
            .map_err(box_err)
            .with_context(|| format!("create consumer {name}"))?;
        Ok(name)
    }

    async fn role_consumer(&self, role: WorkerRole) -> Result<PullConsumer> {
        let name = self.ensure_role_consumer(role).await?;
        let stream = self.js.get_stream(STREAM_JOBS).await.map_err(box_err)?;
        stream
            .get_consumer(&name)
            .await
            .map_err(box_err)
            .with_context(|| format!("get consumer {name}"))
    }

    pub async fn enqueue_jobs(&self, jobs: &[WorkerJob]) -> Result<()> {
        for job in jobs {
            self.enqueue_job(job).await?;
        }
        Ok(())
    }

    pub async fn enqueue_job(&self, job: &WorkerJob) -> Result<()> {
        let subject = Self::subject_for_task(&job.task);
        let body = serde_json::to_vec(job).context("serialize WorkerJob")?;
        let mut headers = HeaderMap::new();
        headers
            .insert(async_nats::header::NATS_MESSAGE_ID, HeaderValue::from(job.job_key.as_str()));
        self.js
            .publish_with_headers(subject, headers, Bytes::from(body))
            .await
            .map_err(box_err)
            .context("publish job")?
            .await
            .map_err(box_err)
            .context("await publish ack")?;
        Ok(())
    }

    /// Pull up to `limit` jobs for `role` (in-flight until ack/nak).
    pub async fn claim_jobs(
        &self,
        role: WorkerRole,
        worker_id: &str,
        limit: u32,
    ) -> Result<Vec<ClaimedJob>> {
        let limit = limit.clamp(1, 64) as usize;
        let mut out = Vec::with_capacity(limit);
        let consumer = self.role_consumer(role).await?;
        let mut batch = consumer
            .fetch()
            .max_messages(limit)
            .expires(Duration::from_millis(500))
            .messages()
            .await
            .map_err(box_err)
            .context("fetch jobs")?;

        while let Some(next) = batch.next().await {
            let message = match next {
                Ok(m) => m,
                Err(err) => {
                    warn!(?err, "nats fetch message error");
                    break;
                },
            };
            match decode_job(&message) {
                Ok(mut job) => {
                    job.status = JobStatus::Running;
                    job.worker_id = Some(worker_id.to_string());
                    job.lease_until = Some(Utc::now() + chrono::Duration::seconds(90));
                    job.updated_at = Utc::now();
                    out.push(ClaimedJob { job, message });
                },
                Err(err) => {
                    warn!(?err, "drop undecodable job message");
                    let _ = message.ack().await;
                },
            }
            if out.len() >= limit {
                break;
            }
        }
        debug!(role = role.as_str(), n = out.len(), "claimed nats jobs");
        Ok(out)
    }

    /// Pull extra extract-wiki messages and keep those whose routes overlap `routes`.
    pub async fn gather_extract_siblings(
        &self,
        worker_id: &str,
        lead_job_key: &str,
        routes: &[String],
        limit: u32,
    ) -> Result<Vec<ClaimedJob>> {
        if routes.is_empty() {
            return Ok(Vec::new());
        }
        let claimed = self.claim_jobs(WorkerRole::Wiki, worker_id, limit).await?;
        let mut kept = Vec::new();
        for claimed in claimed {
            if claimed.job.job_key == lead_job_key {
                let _ = self.release_job(claimed).await;
                continue;
            }
            if claimed.job.task != crate::jobs::TASK_EXTRACT_WIKI {
                let _ = self.release_job(claimed).await;
                continue;
            }
            let their = payload_routes(&claimed.job.payload);
            if routes_overlap(routes, &their) {
                kept.push(claimed);
            } else {
                let _ = self.release_job(claimed).await;
            }
        }
        Ok(kept)
    }

    pub async fn complete_job(
        &self,
        claimed: ClaimedJob,
        ok: bool,
        error: Option<&str>,
    ) -> Result<()> {
        let (mut job, message) = claimed.into_parts();
        if ok {
            message.ack().await.map_err(box_err).context("ack job")?;
            return Ok(());
        }
        job.attempts = job.attempts.saturating_add(1);
        job.last_error = error.map(str::to_string);
        job.updated_at = Utc::now();
        if job.attempts >= job.max_attempts {
            job.status = JobStatus::Dead;
            let body = serde_json::to_vec(&job)?;
            let _ = self.js.publish(SUBJECT_DEAD, Bytes::from(body)).await;
            message.ack().await.map_err(box_err).context("ack after dead publish")?;
            return Ok(());
        }
        let delay_secs = u64::from(job.attempts).saturating_mul(30).clamp(30, 600);
        message
            .ack_with(AckKind::Nak(Some(Duration::from_secs(delay_secs))))
            .await
            .map_err(box_err)
            .context("nak retry")?;
        Ok(())
    }

    /// Return message to the queue without burning a failure (coalesce abort).
    pub async fn release_job(&self, claimed: ClaimedJob) -> Result<()> {
        claimed
            .message
            .ack_with(AckKind::Nak(Some(Duration::from_millis(50))))
            .await
            .map_err(box_err)
            .context("release nak")?;
        Ok(())
    }

    pub async fn queue_stats(&self) -> Result<QueueStats> {
        let mut stream = self.js.get_stream(STREAM_JOBS).await.map_err(box_err)?;
        let info = stream.info().await.map_err(box_err).context("stream info")?;
        let pending = info.state.messages;
        let mut running = 0u64;
        for role in [WorkerRole::Embed, WorkerRole::Compact, WorkerRole::Wiki] {
            let name = format!("rivet-{}", role.as_str());
            if let Ok(mut consumer) = stream.get_consumer::<pull::Config>(&name).await {
                if let Ok(cinfo) = consumer.info().await {
                    running = running.saturating_add(cinfo.num_ack_pending as u64);
                }
            }
        }
        let dead = match self.js.get_stream(STREAM_DEAD).await {
            Ok(mut dead) => dead.info().await.map_or(0, |i| i.state.messages),
            Err(_) => 0,
        };
        Ok(QueueStats { pending, running, done: 0, failed: 0, dead })
    }

    pub async fn list_jobs_by_status(
        &self,
        status: JobStatus,
        limit: u32,
    ) -> Result<Vec<WorkerJob>> {
        if status != JobStatus::Dead {
            return Ok(Vec::new());
        }
        let limit = limit.clamp(1, 200) as usize;
        let stream = self.js.get_stream(STREAM_DEAD).await.map_err(box_err)?;
        let consumer: PullConsumer = stream
            .get_or_create_consumer(
                "rivet-dead-inspect",
                pull::Config {
                    durable_name: Some("rivet-dead-inspect".into()),
                    ack_policy: consumer::AckPolicy::None,
                    deliver_policy: consumer::DeliverPolicy::All,
                    ..Default::default()
                },
            )
            .await
            .map_err(box_err)?;
        let mut batch = consumer
            .fetch()
            .max_messages(limit)
            .expires(Duration::from_millis(400))
            .messages()
            .await
            .map_err(box_err)?;
        let mut out = Vec::new();
        while let Some(next) = batch.next().await {
            let Ok(message) = next else { break };
            if let Ok(job) = decode_job(&message) {
                out.push(job);
            }
            if out.len() >= limit {
                break;
            }
        }
        Ok(out)
    }
}

fn decode_job(message: &Message) -> Result<WorkerJob> {
    let job: WorkerJob =
        serde_json::from_slice(&message.payload).map_err(|e| anyhow!("decode WorkerJob: {e}"))?;
    Ok(job)
}

fn payload_routes(payload: &str) -> Vec<String> {
    let value: serde_json::Value =
        serde_json::from_str(payload).unwrap_or_else(|_| serde_json::json!({}));
    value
        .get("routes")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(|s| s.trim().to_string()))
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

fn routes_overlap(a: &[String], b: &[String]) -> bool {
    a.iter().any(|x| b.iter().any(|y| x == y))
}

#[cfg(test)]
mod tests {
    use super::routes_overlap;

    #[test]
    fn routes_overlap_on_shared_topic() {
        assert!(routes_overlap(
            &["session:a".into(), "topic:auth".into()],
            &["topic:auth".into(), "session:b".into()],
        ));
        assert!(!routes_overlap(
            &["session:a".into()],
            &["session:b".into(), "topic:other".into()],
        ));
    }

    /// Live enqueue/claim/ack against `RIVET_NATS_URL` (ignored by default).
    #[tokio::test]
    #[ignore = "requires live NATS; set RIVET_NATS_URL"]
    async fn smoke_enqueue_claim_ack() {
        let url = std::env::var("RIVET_NATS_URL").expect("RIVET_NATS_URL");
        let store = super::NatsJobStore::connect(&url).await.expect("connect");
        store.ensure_schema().await.expect("schema");
        let job = crate::jobs::WorkerJob::embed_event("smoke-nats-1");
        store.enqueue_job(&job).await.expect("enqueue");
        let claimed = store
            .claim_jobs(crate::jobs::WorkerRole::Embed, "smoke-worker", 1)
            .await
            .expect("claim");
        assert_eq!(claimed.len(), 1);
        assert_eq!(claimed[0].job.job_key, "embed-event:smoke-nats-1");
        store.complete_job(claimed.into_iter().next().unwrap(), true, None).await.expect("ack");
    }
}
