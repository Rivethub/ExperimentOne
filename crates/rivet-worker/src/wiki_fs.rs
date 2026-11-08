//! Keep `wiki_pages` meta in lockstep with the on-disk markdown tree.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use chrono::{DateTime, Utc};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use rivet_core::RivetPaths;
use rivet_store::{MetaStore, WikiPageMeta};
use tracing::{debug, info, warn};

/// Full reconcile: index every `.md` under `wiki/`, drop orphan meta rows.
/// Returns `(upserts, removals)`.
pub fn reconcile_wiki_dir(paths: &RivetPaths, meta: &MetaStore) -> Result<(usize, u64)> {
    let wiki = paths.wiki_dir();
    std::fs::create_dir_all(wiki.as_std_path())?;

    let mut seen_ids: HashSet<String> = HashSet::new();
    let mut upserts = 0usize;

    let entries = match std::fs::read_dir(wiki.as_std_path()) {
        Ok(e) => e,
        Err(err) => {
            warn!(?err, "wiki dir unreadable");
            return Ok((0, 0));
        }
    };

    for entry in entries.flatten() {
        let project_path = entry.path();
        if !project_path.is_dir() {
            continue;
        }
        let Some(project_id) = project_path
            .file_name()
            .and_then(|s| s.to_str())
            .map(ToString::to_string)
        else {
            continue;
        };
        if project_id.starts_with('.') {
            continue;
        }

        for md in walk_markdown(&project_path) {
            let rel = md
                .strip_prefix(&project_path)
                .unwrap_or(&md)
                .to_string_lossy()
                .replace('\\', "/");
            let page = page_from_file(paths, &project_id, &rel, &md);
            seen_ids.insert(page.id.clone());
            let changed = match meta.get_wiki_page(&page.id)? {
                Some(prev) => {
                    prev.title != page.title
                        || prev.path != page.path
                        || prev.updated_at != page.updated_at
                        || prev.project_id != page.project_id
                }
                None => true,
            };
            if changed {
                meta.upsert_wiki_page(&page)?;
                upserts += 1;
            }
        }
    }

    let existing = meta.list_all_wiki_pages()?;
    let mut removed = 0u64;
    for page in existing {
        if !seen_ids.contains(&page.id) && meta.delete_wiki_page(&page.id)? {
            removed += 1;
        }
    }

    if upserts > 0 || removed > 0 {
        debug!(upserts, removed, "wiki fs reconcile");
    }
    Ok((upserts, removed))
}

fn walk_markdown(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in rd.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            if path.is_dir() {
                stack.push(path);
            } else if path
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("md"))
            {
                out.push(path);
            }
        }
    }
    out.sort();
    out
}

fn page_from_file(
    paths: &RivetPaths,
    project_id: &str,
    relative: &str,
    abs: &Path,
) -> WikiPageMeta {
    let body = std::fs::read_to_string(abs).unwrap_or_default();
    let id_suffix = relative
        .trim_end_matches(".md")
        .trim_end_matches(".MD")
        .trim_end_matches(".Md");
    let title = title_from_markdown(&body, id_suffix);
    let stored = relative_wiki_path(paths, abs);
    let updated_at = std::fs::metadata(abs)
        .and_then(|m| m.modified())
        .ok().map_or_else(|| Utc::now().to_rfc3339(), |t| DateTime::<Utc>::from(t).to_rfc3339());

    WikiPageMeta {
        id: format!("{project_id}/{id_suffix}"),
        project_id: project_id.to_string(),
        title,
        path: stored,
        updated_at,
    }
}

fn title_from_markdown(body: &str, fallback: &str) -> String {
    for line in body.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("# ") {
            let title = rest.trim();
            if !title.is_empty() {
                return title.to_string();
            }
        }
    }
    Path::new(fallback)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(fallback)
        .replace(['-', '_'], " ")
}

fn relative_wiki_path(paths: &RivetPaths, abs: &Path) -> String {
    let root = paths.as_root().as_std_path();
    abs.strip_prefix(root).map_or_else(|_| abs.to_string_lossy().replace('\\', "/"), |p| p.to_string_lossy().replace('\\', "/"))
}

/// Watch `wiki/` and reconcile meta on any create/modify/remove (debounced).
pub fn spawn_wiki_watcher(
    paths: RivetPaths,
    meta: Arc<MetaStore>,
    revision: Arc<AtomicU64>,
) -> tokio::task::JoinHandle<()> {
    tokio::task::spawn_blocking(move || {
        match reconcile_wiki_dir(&paths, &meta) {
            Ok(_) => {
                revision.fetch_add(1, Ordering::SeqCst);
                info!("wiki filesystem index ready");
            }
            Err(err) => warn!(?err, "initial wiki reconcile failed"),
        }

        let (tx, rx) = std::sync::mpsc::channel::<()>();
        let mut watcher = match RecommendedWatcher::new(
            move |res: notify::Result<notify::Event>| match res {
                Ok(event) => {
                    if matches!(
                        event.kind,
                        EventKind::Create(_)
                            | EventKind::Modify(_)
                            | EventKind::Remove(_)
                            | EventKind::Any
                    ) {
                        let _ = tx.send(());
                    }
                }
                Err(err) => warn!(?err, "wiki watcher error"),
            },
            notify::Config::default(),
        ) {
            Ok(w) => w,
            Err(err) => {
                warn!(
                    ?err,
                    "wiki watcher unavailable — index only updates on worker ticks"
                );
                return;
            }
        };

        let wiki = paths.wiki_dir();
        if let Err(err) = std::fs::create_dir_all(wiki.as_std_path()) {
            warn!(?err, "could not create wiki dir for watcher");
            return;
        }
        if let Err(err) = watcher.watch(wiki.as_std_path(), RecursiveMode::Recursive) {
            warn!(?err, path = %wiki, "failed to watch wiki dir");
            return;
        }

        info!(path = %wiki, "watching wiki directory");
        loop {
            if rx.recv().is_err() {
                break;
            }
            while rx.recv_timeout(Duration::from_millis(250)).is_ok() {}
            match reconcile_wiki_dir(&paths, &meta) {
                Ok((upserts, removed)) => {
                    if upserts > 0 || removed > 0 {
                        revision.fetch_add(1, Ordering::SeqCst);
                    }
                }
                Err(err) => warn!(?err, "wiki reconcile after fs event failed"),
            }
        }
    })
}
