//! Strip obvious secrets from capture content before store/export.
//!
//! This is best-effort pattern matching — not a guarantee. OAuth blobs and
//! proxy access keys must never be packaged by export code paths regardless.

use regex::Regex;
use std::sync::OnceLock;

use crate::capture::CaptureEvent;

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
            (r"\b(sk-ant-[A-Za-z0-9\-_]{10,})\b", false),
            (r"\b(sk-[A-Za-z0-9]{10,})\b", false),
            (r"\b(xai-[A-Za-z0-9]{20,})\b", false),
            (r"\b(gsk_[A-Za-z0-9]{20,})\b", false),
            (r"\b(AIza[A-Za-z0-9_\-]{20,})\b", false),
            (r"\b(ghp_[A-Za-z0-9]{20,})\b", false),
            (r"\b(gho_[A-Za-z0-9]{20,})\b", false),
            (r"\b(github_pat_[A-Za-z0-9_]{20,})\b", false),
            (r"\b(AKIA[A-Z0-9]{16})\b", false),
            (r"\b(ASIA[A-Z0-9]{16})\b", false),
            (r"\b(rivet_[a-f0-9]{20,})\b", false),
            (r"\b(xox[baprs]-[A-Za-z0-9-]{10,})\b", false),
            (r"\b(xapp-[A-Za-z0-9-]{10,})\b", false),
            (r"\b(npm_[A-Za-z0-9]{20,})\b", false),
            (
                r#"(?i)("(?:access_token|refresh_token|id_token|client_secret|private_key)"\s*:\s*")[^"]+"#,
                true,
            ),
            (
                r"(?i)-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----",
                false,
            ),
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
pub fn redact_event(event: &mut CaptureEvent) {
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

    #[test]
    fn redacts_structured_oauth_fields() {
        let s = redact_text(r#"{"refresh_token":"secret-refresh-value","access_token":"tok"}"#);
        assert!(s.contains("[REDACTED]"));
        assert!(!s.contains("secret-refresh"));
        assert!(!s.contains("\"tok\""));
    }
}
