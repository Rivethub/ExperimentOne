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
        client
            .query(migration.sql)
            .execute()
            .await
            .with_context(|| format!("migration {} ({})", migration.version, migration.name))?;
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
