//! Stable project identifiers derived from working directories.

/// Encode a path the way Claude Code does under `~/.claude/projects/`.
///
/// Absolute path separators become `-` (with a leading `-` for Unix roots). Rivet
/// uses the same encoding so wire capture, local import, and the harness plugin agree.
pub fn encode_path_project_id(path: &str) -> String {
    let trimmed = path.trim().trim_end_matches(['/', '\\']);
    if trimmed.is_empty() || trimmed == "." {
        return "default".into();
    }
    let mut out = String::with_capacity(trimmed.len());
    for ch in trimmed.chars() {
        match ch {
            '/' | '\\' => out.push('-'),
            c => out.push(c),
        }
    }
    if out.is_empty() {
        "default".into()
    } else {
        out
    }
}

/// Prefer a git work tree root when available; otherwise use `cwd` as-is.
pub fn resolve_project_root(cwd: &str) -> String {
    let cwd = cwd.trim();
    if cwd.is_empty() {
        return String::new();
    }
    let path = std::path::Path::new(cwd);
    if let Some(root) = find_git_root(path) {
        return root;
    }
    path.canonicalize()
        .ok()
        .and_then(|p| p.to_str().map(str::to_string))
        .unwrap_or_else(|| cwd.to_string())
}

fn find_git_root(start: &std::path::Path) -> Option<String> {
    let mut cur = start.to_path_buf();
    loop {
        if cur.join(".git").exists() {
            return cur.to_str().map(str::to_string);
        }
        if !cur.pop() {
            return None;
        }
    }
}

/// Hard project id from a harness-reported working directory.
pub fn project_id_from_cwd(cwd: &str) -> Option<String> {
    let root = resolve_project_root(cwd);
    if root.is_empty() {
        return None;
    }
    Some(encode_path_project_id(&root))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_unix_paths_like_claude() {
        assert_eq!(encode_path_project_id("/Users/me/Code/Rivet"), "-Users-me-Code-Rivet");
        assert_eq!(encode_path_project_id("/tmp/"), "-tmp");
    }

    #[test]
    fn empty_cwd_yields_none() {
        assert!(project_id_from_cwd("").is_none());
        assert!(project_id_from_cwd("   ").is_none());
    }
}
