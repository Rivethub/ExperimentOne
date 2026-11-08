//! Shared localhost Host / Origin checks for control + MCP surfaces.

/// Exact allowlist for browser Origin headers (no prefix matching).
pub fn origin_allowed(origin: &str) -> bool {
    matches!(
        origin,
        "http://127.0.0.1:1420"
            | "http://localhost:1420"
            | "http://127.0.0.1:8741"
            | "http://localhost:8741"
            | "tauri://localhost"
            | "https://tauri.localhost"
    )
}

/// Host header is loopback (optional port). Handles `[::1]:8741`.
pub fn host_is_loopback(host_header: &str) -> bool {
    let h = host_header.trim();
    if h.eq_ignore_ascii_case("localhost")
        || h.eq_ignore_ascii_case("127.0.0.1")
        || h.eq_ignore_ascii_case("[::1]")
        || h.eq_ignore_ascii_case("::1")
    {
        return true;
    }
    if let Some(rest) = h.strip_prefix("[::1]:") {
        return rest.chars().all(|c| c.is_ascii_digit());
    }
    if let Some((host, port)) = h.rsplit_once(':') {
        if port.chars().all(|c| c.is_ascii_digit()) {
            return host.eq_ignore_ascii_case("127.0.0.1")
                || host.eq_ignore_ascii_case("localhost");
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_prefix_spoofed_origins() {
        assert!(!origin_allowed("http://localhost.attacker.example"));
        assert!(!origin_allowed("https://tauri.localhost.attacker.example"));
        assert!(!origin_allowed("null"));
        assert!(!origin_allowed("http://evil.com"));
    }

    #[test]
    fn allows_exact_dev_and_tauri_origins() {
        assert!(origin_allowed("http://127.0.0.1:1420"));
        assert!(origin_allowed("http://localhost:1420"));
        assert!(origin_allowed("tauri://localhost"));
        assert!(origin_allowed("https://tauri.localhost"));
    }

    #[test]
    fn host_loopback() {
        assert!(host_is_loopback("127.0.0.1:8741"));
        assert!(host_is_loopback("localhost"));
        assert!(host_is_loopback("[::1]:8741"));
        assert!(host_is_loopback("[::1]"));
        assert!(!host_is_loopback("example.com"));
    }
}
