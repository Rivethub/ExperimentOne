//! `.rivetbag` = tar + gzip of traffic JSON (+ optional wiki/embeddings later).
//! Also imports local Claude Code / Codex / Cursor transcripts already on disk.
//! Never includes OAuth, API keys, or proxy access secrets.

mod harness_ingest;

pub use harness_ingest::{
    default_claude_projects_root, default_codex_sessions_root, default_cursor_projects_root,
    ingest_local, LocalIngestOptions, LocalIngestReport, LocalSource, LocalSourceReport,
};

use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::Arc;

use anyhow::{bail, Context, Result};
use chrono::Utc;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use rivet_core::{ExportManifest, TrafficEvent};
use rivet_store::TrafficStore;
use tar::{Archive, Builder};

pub async fn export_bag(store: Arc<dyn TrafficStore>, out_path: &Path) -> Result<ExportManifest> {
    export_bag_with_paths(store, out_path, None).await
}

/// Export traffic; when `paths` is set, hydrate `body_ref` blobs into `content` first.
pub async fn export_bag_with_paths(
    store: Arc<dyn TrafficStore>,
    out_path: &Path,
    paths: Option<&rivet_core::RivetPaths>,
) -> Result<ExportManifest> {
    let mut events = store.export_all().await?;
    if let Some(paths) = paths {
        rivet_core::hydrate_events(paths, &mut events);
    }
    let manifest = ExportManifest {
        schema_version: ExportManifest::SCHEMA_VERSION,
        created_at: Utc::now(),
        event_count: events.len() as u64,
        includes_embeddings: false,
        includes_wiki: false,
        note: Some("Rivet traffic export — credentials excluded".into()),
    };

    let file = File::create(out_path).with_context(|| format!("create {}", out_path.display()))?;
    let enc = GzEncoder::new(file, Compression::default());
    let mut builder = Builder::new(enc);

    let manifest_bytes = serde_json::to_vec_pretty(&manifest)?;
    append_bytes(&mut builder, "manifest.json", &manifest_bytes)?;

    let events_bytes = serde_json::to_vec(&events)?;
    append_bytes(&mut builder, "traffic_events.json", &events_bytes)?;

    builder.finish()?;
    Ok(manifest)
}

pub fn import_bag(path: &Path) -> Result<(ExportManifest, Vec<TrafficEvent>)> {
    let file = File::open(path).with_context(|| format!("open {}", path.display()))?;
    let dec = GzDecoder::new(file);
    let mut archive = Archive::new(dec);

    let mut manifest: Option<ExportManifest> = None;
    let mut events: Option<Vec<TrafficEvent>> = None;

    for entry in archive.entries()? {
        let mut entry = entry?;
        let name = entry.path()?.to_string_lossy().to_string();
        let mut buf = Vec::new();
        entry.read_to_end(&mut buf)?;
        match name.as_str() {
            "manifest.json" => manifest = Some(serde_json::from_slice(&buf)?),
            "traffic_events.json" => events = Some(serde_json::from_slice(&buf)?),
            other => tracing::debug!(other, "skipping unknown bag entry"),
        }
    }

    let manifest = manifest.context("manifest.json missing from rivetbag")?;
    if manifest.schema_version > ExportManifest::SCHEMA_VERSION {
        bail!(
            "rivetbag schema {} newer than supported {}",
            manifest.schema_version,
            ExportManifest::SCHEMA_VERSION
        );
    }
    let events = events.context("traffic_events.json missing from rivetbag")?;
    Ok((manifest, events))
}

pub async fn import_into_store(
    store: Arc<dyn TrafficStore>,
    path: &Path,
) -> Result<ExportManifest> {
    let (manifest, events) = import_bag(path)?;
    store.insert_batch(&events).await?;
    Ok(manifest)
}

fn append_bytes<W: Write>(builder: &mut Builder<W>, name: &str, bytes: &[u8]) -> Result<()> {
    let mut header = tar::Header::new_gnu();
    header.set_size(bytes.len() as u64);
    header.set_mode(0o644);
    header.set_cksum();
    builder.append_data(&mut header, name, bytes)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use rivet_core::{ProviderKind, UsageTotals};
    use std::sync::Mutex;

    struct MemStore {
        events: Mutex<Vec<TrafficEvent>>,
    }

    #[async_trait]
    impl TrafficStore for MemStore {
        async fn insert_event(&self, event: &TrafficEvent) -> Result<()> {
            self.events.lock().unwrap().push(event.clone());
            Ok(())
        }
        async fn insert_batch(&self, events: &[TrafficEvent]) -> Result<()> {
            self.events.lock().unwrap().extend_from_slice(events);
            Ok(())
        }
        async fn recent(&self, limit: u32) -> Result<Vec<TrafficEvent>> {
            let ev = self.events.lock().unwrap();
            Ok(ev.iter().rev().take(limit as usize).cloned().collect())
        }
        async fn search_keyword(&self, _q: &str, limit: u32) -> Result<Vec<TrafficEvent>> {
            self.recent(limit).await
        }
        async fn get_by_ids(&self, ids: &[String]) -> Result<Vec<TrafficEvent>> {
            let set: std::collections::HashSet<_> = ids.iter().cloned().collect();
            Ok(self
                .events
                .lock()
                .unwrap()
                .iter()
                .filter(|e| set.contains(&e.id.to_string()))
                .cloned()
                .collect())
        }
        async fn export_all(&self) -> Result<Vec<TrafficEvent>> {
            Ok(self.events.lock().unwrap().clone())
        }
        async fn usage_totals(&self) -> Result<UsageTotals> {
            Ok(UsageTotals::default())
        }
    }

    #[tokio::test]
    async fn rivetbag_roundtrip_preserves_redacted_content() {
        let mut ev = TrafficEvent::new(ProviderKind::Claude);
        ev.content = Some("hello Authorization: Bearer sk-secret1234567890".into());
        rivet_core::redact_event(&mut ev);
        let store: Arc<dyn TrafficStore> = Arc::new(MemStore { events: Mutex::new(vec![ev]) });
        let dir = std::env::temp_dir().join(format!(
            "rivet-export-test-{}",
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.rivetbag");
        let manifest = export_bag(store, &path).await.unwrap();
        assert_eq!(manifest.event_count, 1);
        let (m2, events) = import_bag(&path).unwrap();
        assert_eq!(m2.event_count, 1);
        assert_eq!(events.len(), 1);
        let content = events[0].content.as_deref().unwrap_or("");
        assert!(content.contains("[REDACTED]"));
        assert!(!content.contains("sk-secret"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
