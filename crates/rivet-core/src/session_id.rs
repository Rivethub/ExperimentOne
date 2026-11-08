//! Canonical session identity for captured traffic.
//!
//! Wire captures often carry a bare harness id. Prefer `provider:nativeId` so
//! conversations stay stable across soft hashes, imports, and multi-harness use.

use crate::traffic::ProviderKind;

/// Build a canonical session key from provider + native harness id.
///
/// Soft sessions (`soft:…`) and already-canonical keys are left unchanged.
#[must_use]
pub fn canonicalize_session_id(provider: ProviderKind, session_id: Option<&str>) -> Option<String> {
    let raw = session_id.map(str::trim).filter(|s| !s.is_empty())?;
    if raw.starts_with("soft:") || raw.starts_with("event:") {
        return Some(raw.to_string());
    }
    if let Some((prefix, rest)) = raw.split_once(':') {
        if !prefix.is_empty() && !rest.is_empty() && !prefix.contains('/') {
            // Already looks like harness:native (or soft already handled).
            return Some(raw.to_string());
        }
    }
    Some(format!("{}:{raw}", provider.as_str()))
}

/// Strip a known provider prefix when present.
#[must_use]
pub fn native_session_id(session_id: &str) -> &str {
    let trimmed = session_id.trim();
    if let Some((prefix, rest)) = trimmed.split_once(':') {
        if matches!(
            prefix,
            "claude"
                | "codex"
                | "openai"
                | "gemini"
                | "antigravity"
                | "kimi"
                | "kimi-ai"
                | "xai"
                | "meta"
                | "devin"
                | "vertex"
                | "cursor"
                | "other"
        ) && !rest.is_empty()
        {
            return rest;
        }
    }
    trimmed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefixes_bare_ids() {
        assert_eq!(
            canonicalize_session_id(ProviderKind::Claude, Some("abc-123")).as_deref(),
            Some("claude:abc-123")
        );
    }

    #[test]
    fn leaves_canonical_and_soft() {
        assert_eq!(
            canonicalize_session_id(ProviderKind::Claude, Some("claude:abc")).as_deref(),
            Some("claude:abc")
        );
        assert_eq!(
            canonicalize_session_id(ProviderKind::Claude, Some("soft:deadbeef")).as_deref(),
            Some("soft:deadbeef")
        );
    }
}
