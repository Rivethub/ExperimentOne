//! `.rivetbag` = tar + gzip of traffic JSON (+ optional wiki/embeddings later).
//! Never includes OAuth, API keys, or proxy access secrets.

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
    let events = store.export_all().await?;
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

pub async fn import_into_store(store: Arc<dyn TrafficStore>, path: &Path) -> Result<ExportManifest> {
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
