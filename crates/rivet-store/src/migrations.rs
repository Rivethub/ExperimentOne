//! Versioned `ClickHouse` schema migrations for Rivet.

use anyhow::{Context, Result};
use clickhouse::Client;
use tracing::info;

/// One forward-only migration applied exactly once (tracked in `schema_migrations`).
#[derive(Debug, Clone, Copy)]
pub struct Migration {
    pub version: u32,
    pub name: &'static str,
    pub sql: &'static str,
}

pub const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "traffic_events_base",
        sql: r"
CREATE TABLE IF NOT EXISTS traffic_events (
  id UUID,
  ts DateTime64(3, 'UTC'),
  provider LowCardinality(String),
  account_label Nullable(String),
  model LowCardinality(Nullable(String)),
  session_id Nullable(String),
  project_id Nullable(String),
  request_id Nullable(String),
  role LowCardinality(String),
  content Nullable(String),
  tokens_in UInt32,
  tokens_out UInt32,
  latency_ms Nullable(UInt64),
  status_code Nullable(UInt16),
  body_ref Nullable(String)
) ENGINE = MergeTree
ORDER BY (ts, id)
",
    },
    Migration {
        version: 2,
        name: "traffic_events_capture_quality",
        sql: r"
ALTER TABLE traffic_events
  ADD COLUMN IF NOT EXISTS capture_quality LowCardinality(Nullable(String))
",
    },
    Migration {
        version: 3,
        name: "traffic_events_cwd",
        sql: r"
ALTER TABLE traffic_events
  ADD COLUMN IF NOT EXISTS cwd Nullable(String)
",
    },
    Migration {
        version: 4,
        name: "embeddings_hnsw",
        sql: r"
CREATE TABLE IF NOT EXISTS embeddings (
  event_id UUID,
  space LowCardinality(String),
  dims Array(Float32),
  updated_at DateTime64(3, 'UTC'),
  INDEX vec_hnsw dims TYPE vector_similarity('hnsw', 'cosineDistance', 64)
) ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (space, event_id)
",
    },
    Migration {
        version: 5,
        name: "traffic_events_hub_fields",
        sql: r"
ALTER TABLE traffic_events
  ADD COLUMN IF NOT EXISTS agent_id Nullable(String),
  ADD COLUMN IF NOT EXISTS parent_agent_id Nullable(String),
  ADD COLUMN IF NOT EXISTS parent_session_id Nullable(String),
  ADD COLUMN IF NOT EXISTS request_class LowCardinality(Nullable(String)),
  ADD COLUMN IF NOT EXISTS agent_type Nullable(String),
  ADD COLUMN IF NOT EXISTS cache_read_tokens UInt32 DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cache_creation_tokens UInt32 DEFAULT 0,
  ADD COLUMN IF NOT EXISTS thinking_tokens UInt32 DEFAULT 0,
  ADD COLUMN IF NOT EXISTS git_branch Nullable(String),
  ADD COLUMN IF NOT EXISTS git_repo Nullable(String),
  ADD COLUMN IF NOT EXISTS task_id Nullable(String),
  ADD COLUMN IF NOT EXISTS turn_id Nullable(String),
  ADD COLUMN IF NOT EXISTS upstream_host Nullable(String),
  ADD COLUMN IF NOT EXISTS attempt_count UInt32 DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stop_reason LowCardinality(Nullable(String)),
  ADD COLUMN IF NOT EXISTS tool_names Nullable(String),
  ADD COLUMN IF NOT EXISTS stream_complete Nullable(UInt8),
  ADD COLUMN IF NOT EXISTS request_path Nullable(String),
  ADD COLUMN IF NOT EXISTS api_format LowCardinality(Nullable(String)),
  ADD COLUMN IF NOT EXISTS error_type LowCardinality(Nullable(String)),
  ADD COLUMN IF NOT EXISTS error_message Nullable(String),
  ADD COLUMN IF NOT EXISTS auth_id Nullable(String),
  ADD COLUMN IF NOT EXISTS has_thinking Nullable(UInt8),
  ADD COLUMN IF NOT EXISTS media_count UInt32 DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tool_call_count UInt32 DEFAULT 0
",
    },
    Migration {
        version: 6,
        name: "rename_traffic_events_to_capture_events",
        // Applied only when `traffic_events` still exists (see `run`).
        sql: "RENAME TABLE traffic_events TO capture_events",
    },
];

const SCHEMA_MIGRATIONS_DDL: &str = r"
CREATE TABLE IF NOT EXISTS schema_migrations (
  version UInt32,
  name String,
  applied_at DateTime64(3, 'UTC') DEFAULT now64(3)
) ENGINE = MergeTree
ORDER BY version
";

#[derive(Debug, clickhouse::Row, serde::Deserialize)]
struct VersionRow {
    version: u32,
}

#[derive(Debug, clickhouse::Row, serde::Deserialize)]
struct NameRow {
    #[allow(dead_code)]
    name: String,
}

async fn table_exists(client: &Client, name: &str) -> Result<bool> {
    #[allow(clippy::literal_string_with_formatting_args)]
    let sql = "SELECT name FROM system.tables WHERE database = currentDatabase() AND name = {name:String}";
    let rows = client.query(sql).param("name", name).fetch_all::<NameRow>().await?;
    Ok(!rows.is_empty())
}

/// Apply all pending migrations against the `rivet` database.
pub async fn run(client: &Client) -> Result<u32> {
    client.query(SCHEMA_MIGRATIONS_DDL).execute().await.context("schema_migrations ddl")?;

    let applied = client
        .query("SELECT version FROM schema_migrations ORDER BY version")
        .fetch_all::<VersionRow>()
        .await
        .unwrap_or_default();
    let applied: std::collections::HashSet<u32> = applied.into_iter().map(|r| r.version).collect();

    let mut ran = 0u32;
    for migration in MIGRATIONS {
        if applied.contains(&migration.version) {
            continue;
        }
        info!(version = migration.version, name = migration.name, "applying clickhouse migration");

        if migration.version == 6 {
            // Existing installs: rename. Fresh installs after v1–5: same.
            // Already-renamed / partially upgraded: no-op if capture_events exists.
            let has_old = table_exists(client, "traffic_events").await?;
            let has_new = table_exists(client, "capture_events").await?;
            if has_old && !has_new {
                client
                    .query(migration.sql)
                    .execute()
                    .await
                    .with_context(|| format!("migration {} ({})", migration.version, migration.name))?;
            } else if !has_new {
                // Should not happen if v1 applied; create empty capture_events as safety net.
                client
                    .query(
                        r"
CREATE TABLE IF NOT EXISTS capture_events (
  id UUID,
  ts DateTime64(3, 'UTC'),
  provider LowCardinality(String),
  account_label Nullable(String),
  model LowCardinality(Nullable(String)),
  session_id Nullable(String),
  project_id Nullable(String),
  request_id Nullable(String),
  role LowCardinality(String),
  content Nullable(String),
  tokens_in UInt32,
  tokens_out UInt32,
  latency_ms Nullable(UInt64),
  status_code Nullable(UInt16),
  body_ref Nullable(String),
  capture_quality LowCardinality(Nullable(String)),
  cwd Nullable(String),
  agent_id Nullable(String),
  parent_agent_id Nullable(String),
  parent_session_id Nullable(String),
  request_class LowCardinality(Nullable(String)),
  agent_type Nullable(String),
  cache_read_tokens UInt32 DEFAULT 0,
  cache_creation_tokens UInt32 DEFAULT 0,
  thinking_tokens UInt32 DEFAULT 0,
  git_branch Nullable(String),
  git_repo Nullable(String),
  task_id Nullable(String),
  turn_id Nullable(String),
  upstream_host Nullable(String),
  attempt_count UInt32 DEFAULT 0,
  stop_reason LowCardinality(Nullable(String)),
  tool_names Nullable(String),
  stream_complete Nullable(UInt8),
  request_path Nullable(String),
  api_format LowCardinality(Nullable(String)),
  error_type LowCardinality(Nullable(String)),
  error_message Nullable(String),
  auth_id Nullable(String),
  has_thinking Nullable(UInt8),
  media_count UInt32 DEFAULT 0,
  tool_call_count UInt32 DEFAULT 0
) ENGINE = MergeTree
ORDER BY (ts, id)
",
                    )
                    .execute()
                    .await
                    .with_context(|| format!("migration {} fallback create", migration.version))?;
            }
        } else {
            client
                .query(migration.sql)
                .execute()
                .await
                .with_context(|| format!("migration {} ({})", migration.version, migration.name))?;
        }

        // ClickHouse `{name:Type}` binds — not Rust `format!` args.
        #[allow(clippy::literal_string_with_formatting_args)]
        let insert_sql =
            "INSERT INTO schema_migrations (version, name) VALUES ({version:UInt32}, {name:String})";
        client
            .query(insert_sql)
            .param("version", migration.version)
            .param("name", migration.name)
            .execute()
            .await
            .with_context(|| format!("record migration {}", migration.version))?;
        ran += 1;
    }
    Ok(ran)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrations_are_ordered_and_unique() {
        let mut last = 0u32;
        let mut seen = std::collections::HashSet::new();
        for m in MIGRATIONS {
            assert!(m.version > last, "migration versions must increase");
            assert!(seen.insert(m.version), "duplicate migration version");
            assert_ne!(m.name, "");
            assert_ne!(m.sql.trim(), "");
            last = m.version;
        }
    }
}
