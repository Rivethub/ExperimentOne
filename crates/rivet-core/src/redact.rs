//! Strip obvious secrets from traffic content before store/export.
//!
//! This is best-effort pattern matching — not a guarantee. OAuth blobs and
//! proxy access keys must never be packaged by export code paths regardless.

use regex::Regex;
use std::sync::OnceLock;

use crate::traffic::TrafficEvent;

struct Rule {
    re: Regex,
    /// When true, keep capture group 1 and append `[REDACTED]`.
    keep_prefix: bool,
}

fn rules() -> &'static [Rule] {
    static RULES: OnceLock<Vec<Rule>> = OnceLock::new();
    RULES.get_or_init(|| {
        [
            (
                r#"(?i)(Authorization["']?\s*[:=]\s*["']?Bearer\s+)[A-Za-z0-9._\-+=/]+"#,
                true,
            ),
            (
                r#"(?i)((?:x-api-key|api[_-]?key|anthropic-api-key)["']?\s*[:=]\s*["']?)[A-Za-z0-9._\-+=/]+"#,
                true,
            ),
            (r"\b(sk-proj-[A-Za-z0-9\-_]{10,})\b", false),
            (r"\b(sk-[A-Za-z0-9]{10,})\b", false),
            (r"\b(rivet_[a-f0-9]{20,})\b", false),
            (r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b", false),
        ]
        .into_iter()
        .map(|(p, keep_prefix)| Rule {
            re: Regex::new(p).expect("redaction regex"),
            keep_prefix,
        })
        .collect()
    })
}

/// Redact secret-looking substrings in free text.
pub fn redact_text(input: &str) -> String {
    let mut out = input.to_string();
    for rule in rules() {
        out = if rule.keep_prefix {
            rule.re.replace_all(&out, "${1}[REDACTED]").into_owned()
        } else {
            rule.re.replace_all(&out, "[REDACTED]").into_owned()
        };
    }
    out
}

/// Apply redaction to an event's content field (in place).
pub fn redact_event(event: &mut TrafficEvent) {
    if let Some(content) = event.content.as_mut() {
        *content = redact_text(content);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_bearer_and_sk() {
        let s = redact_text(
            "Authorization: Bearer sk-abc1234567890xyz and rivet_0fc42fa80feb45929eef1be13d797173",
        );
        assert!(s.contains("[REDACTED]"));
        assert!(!s.contains("sk-abc"));
        assert!(!s.contains("rivet_0fc42"));
    }
}
