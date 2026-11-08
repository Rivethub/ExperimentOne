//! Read spilled traffic bodies under `blobs/`.

use std::fs;
use std::path::{Component, Path, PathBuf};

use anyhow::{bail, Context, Result};

use crate::paths::RivetPaths;

/// Resolve a `body_ref` (relative path under blobs/) to an absolute path.
/// Rejects absolute paths and `..` components.
pub fn resolve_body_ref(paths: &RivetPaths, body_ref: &str) -> Result<PathBuf> {
    let trimmed = body_ref.trim();
    if trimmed.is_empty() {
        bail!("empty body_ref");
    }
    if trimmed.starts_with('/') || trimmed.starts_with('\\') {
        bail!("body_ref must be relative");
    }
    let rel = Path::new(trimmed);
    if rel.is_absolute() {
        bail!("body_ref must be relative");
    }
    for comp in rel.components() {
        match comp {
            Component::Normal(_) => {},
            Component::CurDir => {},
            _ => bail!("body_ref must not contain '..' or prefixes"),
        }
    }
    Ok(paths.blobs_dir().as_std_path().join(rel))
}

/// Load the full spilled body for a traffic event, if present on disk.
pub fn read_body_ref(paths: &RivetPaths, body_ref: &str) -> Result<String> {
    let path = resolve_body_ref(paths, body_ref)?;
    fs::read_to_string(&path).with_context(|| format!("read blob {}", path.display()))
}

/// Replace `content` with the spilled body when `body_ref` resolves.
pub fn hydrate_event_content(paths: &RivetPaths, event: &mut crate::TrafficEvent) {
    let Some(body_ref) = event.body_ref.as_deref() else {
        return;
    };
    if let Ok(full) = read_body_ref(paths, body_ref) {
        if !full.is_empty() {
            event.content = Some(full);
        }
    }
}

pub fn hydrate_events(paths: &RivetPaths, events: &mut [crate::TrafficEvent]) {
    for event in events {
        hydrate_event_content(paths, event);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use camino::Utf8PathBuf;

    #[test]
    fn rejects_traversal() {
        let paths = RivetPaths { root: Utf8PathBuf::from("/tmp/rivet-test-root") };
        assert!(resolve_body_ref(&paths, "../etc/passwd").is_err());
        assert!(resolve_body_ref(&paths, "/abs").is_err());
        let ok = resolve_body_ref(&paths, "traffic/2026/11/08/x.txt").unwrap();
        assert!(ok.ends_with("blobs/traffic/2026/11/08/x.txt"));
    }
}
