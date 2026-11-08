//! Assemble a budgeted "Memory for this session" block (RivetHub-style).

use std::fmt::Write as _;
use std::path::Path;

pub const STARTUP_BUDGET_TOKENS: usize = 4000;
const WORKSPACE_SHARE: usize = 1400;
const TOPIC_SHARE: usize = 1000;
const RECENT_SHARE: usize = 800;
const HITS_SHARE: usize = 800;

/// Well-known workspace identity / memory filenames (RivetOS-style).
/// `(relative path, section title)`.
pub const WORKSPACE_MEMORY_FILES: &[(&str, &str)] = &[
    ("SOUL.md", "Soul"),
    ("IDENTITY.md", "Identity"),
    ("MEMORY.md", "Memory"),
    ("AGENTS.md", "Agents"),
    (".rivet/SOUL.md", "Soul"),
    (".rivet/IDENTITY.md", "Identity"),
    (".rivet/MEMORY.md", "Memory"),
    ("memory/SOUL.md", "Soul"),
    ("memory/IDENTITY.md", "Identity"),
    ("memory/MEMORY.md", "Memory"),
];

#[must_use]
pub fn estimate_tokens(text: &str) -> usize {
    text.chars().count().div_ceil(4).max(1)
}

#[must_use]
pub fn trim_to_tokens(text: &str, budget: usize) -> String {
    if estimate_tokens(text) <= budget {
        return text.to_string();
    }
    let max_chars = budget.saturating_mul(4);
    let mut out: String = text.chars().take(max_chars.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// One workspace memory section (SOUL / IDENTITY / MEMORY / …).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceMemorySection {
    pub title: String,
    pub body: String,
}

/// Read SOUL / IDENTITY / MEMORY (and a few aliases) from a project root.
/// First file wins per title so `.rivet/MEMORY.md` does not duplicate `MEMORY.md`.
#[must_use]
pub fn load_workspace_memory(cwd: &Path) -> Vec<WorkspaceMemorySection> {
    let mut out = Vec::new();
    let mut seen_titles = std::collections::BTreeSet::new();
    for (rel, title) in WORKSPACE_MEMORY_FILES {
        if seen_titles.contains(*title) {
            continue;
        }
        let candidates = [cwd.join(rel), cwd.join(rel.to_ascii_lowercase())];
        let Some(body) = candidates
            .iter()
            .find_map(|path| std::fs::read_to_string(path).ok().map(|s| s.trim().to_string()))
        else {
            continue;
        };
        if body.is_empty() {
            continue;
        }
        seen_titles.insert((*title).to_string());
        out.push(WorkspaceMemorySection { title: (*title).to_string(), body });
    }
    out
}

/// Build a startup memory document from workspace identity files, topic page,
/// recent session lines, and search hits.
#[must_use]
pub fn assemble_startup_memory(
    topic_title: Option<&str>,
    topic_page: Option<&str>,
    recent_lines: &[String],
    hit_lines: &[String],
) -> String {
    assemble_startup_memory_with_workspace(topic_title, topic_page, &[], recent_lines, hit_lines)
}

/// Same as [`assemble_startup_memory`], with optional workspace SOUL/IDENTITY/MEMORY sections.
#[must_use]
pub fn assemble_startup_memory_with_workspace(
    topic_title: Option<&str>,
    topic_page: Option<&str>,
    workspace: &[WorkspaceMemorySection],
    recent_lines: &[String],
    hit_lines: &[String],
) -> String {
    let mut out = String::from("## Memory for this session\n\n");
    if let Some(title) = topic_title.filter(|t| !t.trim().is_empty()) {
        let _ = writeln!(out, "Topic: **{title}**\n");
    }
    if !workspace.is_empty() {
        out.push_str("### Workspace identity\n\n");
        let per = (WORKSPACE_SHARE / workspace.len().max(1)).max(200);
        for section in workspace {
            let _ = writeln!(out, "#### {}\n", section.title);
            out.push_str(&trim_to_tokens(&section.body, per));
            out.push_str("\n\n");
        }
        // Re-trim the whole workspace block to the share budget.
        // (Individual sections already capped; keep a hard ceiling.)
        let marker = "### Workspace identity\n\n";
        if let Some(idx) = out.find(marker) {
            let head = &out[..idx + marker.len()];
            let rest = &out[idx + marker.len()..];
            // Find next ### or end — trim only workspace body portion loosely.
            let split_at = rest.find("\n### ").unwrap_or(rest.len());
            let workspace_body = trim_to_tokens(&rest[..split_at], WORKSPACE_SHARE);
            let after = &rest[split_at..];
            out = format!("{head}{workspace_body}{after}");
            if !out.ends_with('\n') {
                out.push('\n');
            }
        }
    }
    if let Some(page) = topic_page.filter(|t| !t.trim().is_empty()) {
        out.push_str("### Topic context\n\n");
        out.push_str(&trim_to_tokens(page, TOPIC_SHARE));
        out.push_str("\n\n");
    }
    if !recent_lines.is_empty() {
        out.push_str("### Recent sessions\n\n");
        let mut body = String::new();
        for line in recent_lines {
            body.push_str("- ");
            body.push_str(line);
            body.push('\n');
            if estimate_tokens(&body) >= RECENT_SHARE {
                break;
            }
        }
        out.push_str(&trim_to_tokens(&body, RECENT_SHARE));
        out.push('\n');
    }
    if !hit_lines.is_empty() {
        out.push_str("### Relevant memory\n\n");
        let mut body = String::new();
        for line in hit_lines {
            body.push_str("- ");
            body.push_str(line);
            body.push('\n');
            if estimate_tokens(&body) >= HITS_SHARE {
                break;
            }
        }
        out.push_str(&trim_to_tokens(&body, HITS_SHARE));
        out.push('\n');
    }
    trim_to_tokens(&out, STARTUP_BUDGET_TOKENS)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn assembles_sections() {
        let doc = assemble_startup_memory(
            Some("Auth"),
            Some("Currently, OAuth uses PKCE."),
            &["session a · fixed redirect".into()],
            &["Searched memory for oauth".into()],
        );
        assert!(doc.contains("Memory for this session"));
        assert!(doc.contains("Topic context"));
        assert!(doc.contains("Relevant memory"));
    }

    #[test]
    fn includes_workspace_identity() {
        let doc = assemble_startup_memory_with_workspace(
            None,
            None,
            &[WorkspaceMemorySection {
                title: "Soul".into(),
                body: "Be concise and local-first.".into(),
            }],
            &[],
            &[],
        );
        assert!(doc.contains("Workspace identity"));
        assert!(doc.contains("Be concise and local-first"));
    }

    #[test]
    fn loads_soul_memory_files() {
        let dir = std::env::temp_dir().join(format!("rivet-startup-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("SOUL.md"), "Prefer proxy-only capture.\n").unwrap();
        fs::write(dir.join("MEMORY.md"), "Last decision: soft→wire.\n").unwrap();
        let sections = load_workspace_memory(&dir);
        let titles: Vec<_> = sections.iter().map(|s| s.title.as_str()).collect();
        assert!(titles.contains(&"Soul"));
        assert!(titles.contains(&"Memory"));
        let _ = fs::remove_dir_all(&dir);
    }
}
