//! OAuth / credential providers mirrored from CLIProxyAPI (prox).

use serde::{Deserialize, Serialize};

/// How a provider is signed into Rivet's managed proxy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoginKind {
    /// Browser OAuth callback (`-*-login` flag).
    OauthBrowser,
    /// Device-code / RFC 8628 flow.
    OauthDevice,
    /// Service-account / key file import (Vertex).
    FileImport,
}

/// One provider Rivet can manage — kept in lockstep with prox TUI + CLI login flags.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderCatalogEntry {
    /// Canonical id used in APIs and traffic (`claude`, `kimi-ai`, …).
    pub id: String,
    pub label: String,
    /// Short badge letter/glyph for the UI.
    pub badge: String,
    pub login_kind: LoginKind,
    /// CLIProxyAPI flag when spawning a one-shot login process (without leading `-`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub login_flag: Option<String>,
    /// Alternate ids accepted by `POST /v1/accounts/login`.
    pub aliases: Vec<String>,
    pub hint: String,
    /// Accent color token for the desktop UI.
    pub color: String,
}

/// Full catalog of providers prox supports for credential acquisition.
pub fn provider_catalog() -> Vec<ProviderCatalogEntry> {
    vec![
        ProviderCatalogEntry {
            id: "claude".into(),
            label: "Claude (Anthropic)".into(),
            badge: "C".into(),
            login_kind: LoginKind::OauthBrowser,
            login_flag: Some("claude-login".into()),
            aliases: vec!["anthropic".into()],
            hint: "Browser OAuth — complete sign-in in the opened window.".into(),
            color: "#f97316".into(),
        },
        ProviderCatalogEntry {
            id: "codex".into(),
            label: "Codex (OpenAI)".into(),
            badge: "X".into(),
            login_kind: LoginKind::OauthDevice,
            login_flag: Some("codex-device-login".into()),
            aliases: vec!["openai".into(), "open_ai".into()],
            hint: "Device code — open auth.openai.com/codex/device and enter the code.".into(),
            color: "#60a5fa".into(),
        },
        ProviderCatalogEntry {
            id: "antigravity".into(),
            label: "Antigravity".into(),
            badge: "A".into(),
            login_kind: LoginKind::OauthBrowser,
            login_flag: Some("antigravity-login".into()),
            aliases: vec!["google".into(), "gemini".into()],
            hint: "Browser OAuth for Antigravity / Google Cloud Code credentials.".into(),
            color: "#a78bfa".into(),
        },
        ProviderCatalogEntry {
            id: "kimi".into(),
            label: "Kimi (kimi.com)".into(),
            badge: "K".into(),
            login_kind: LoginKind::OauthDevice,
            login_flag: Some("kimi-login".into()),
            aliases: vec!["kimi.com".into(), "moonshot".into()],
            hint: "Device / OAuth login for kimi.com.".into(),
            color: "#d97706".into(),
        },
        ProviderCatalogEntry {
            id: "kimi-ai".into(),
            label: "Kimi (kimi.ai)".into(),
            badge: "キ".into(),
            login_kind: LoginKind::OauthDevice,
            login_flag: Some("kimi-ai-login".into()),
            aliases: vec!["kimi.ai".into()],
            hint: "Device / OAuth login for kimi.ai.".into(),
            color: "#b45309".into(),
        },
        ProviderCatalogEntry {
            id: "xai".into(),
            label: "xAI".into(),
            badge: "χ".into(),
            login_kind: LoginKind::OauthDevice,
            login_flag: Some("xai-login".into()),
            aliases: vec!["grok".into()],
            hint: "Device / OAuth login for xAI (Grok).".into(),
            color: "#e4e4e7".into(),
        },
        ProviderCatalogEntry {
            id: "meta".into(),
            label: "Meta".into(),
            badge: "M".into(),
            login_kind: LoginKind::OauthDevice,
            login_flag: Some("meta-login".into()),
            aliases: vec!["llama".into()],
            hint: "Device / OAuth login for Meta AI credentials.".into(),
            color: "#3b82f6".into(),
        },
        ProviderCatalogEntry {
            id: "devin".into(),
            label: "Devin".into(),
            badge: "D".into(),
            login_kind: LoginKind::OauthBrowser,
            login_flag: Some("devin-login".into()),
            aliases: vec![],
            hint: "Browser OAuth for Devin credentials.".into(),
            color: "#22d3ee".into(),
        },
        ProviderCatalogEntry {
            id: "vertex".into(),
            label: "Vertex AI".into(),
            badge: "V".into(),
            login_kind: LoginKind::FileImport,
            login_flag: None,
            aliases: vec!["google-vertex".into()],
            hint: "Import a Google Cloud service-account JSON (prox -vertex-import).".into(),
            color: "#34d399".into(),
        },
    ]
}

/// Resolve a catalog entry from a user/API provider string.
pub fn find_provider(raw: &str) -> Option<&'static ProviderCatalogEntry> {
    // Leak-free: catalog is small and static via OnceLock.
    use std::sync::OnceLock;
    static CATALOG: OnceLock<Vec<ProviderCatalogEntry>> = OnceLock::new();
    let catalog = CATALOG.get_or_init(provider_catalog);
    let key = raw.trim().to_ascii_lowercase();
    catalog.iter().find(|p| {
        p.id == key
            || p.aliases
                .iter()
                .any(|a| a.eq_ignore_ascii_case(&key))
    })
}

/// Normalize traffic / credential provider labels into a stable id.
pub fn normalize_provider_id(raw: &str) -> String {
    let s = raw.trim().to_ascii_lowercase();
    if let Some(p) = find_provider(&s) {
        return p.id.clone();
    }
    if s.contains("claude") || s == "anthropic" {
        "claude".into()
    } else if s.contains("codex") || s.contains("openai") {
        "codex".into()
    } else if s.contains("antigravity") {
        "antigravity".into()
    } else if s.contains("kimi.ai") || s == "kimi-ai" {
        "kimi-ai".into()
    } else if s.contains("kimi") || s.contains("moonshot") {
        "kimi".into()
    } else if s.contains("xai") || s.contains("grok") {
        "xai".into()
    } else if s.contains("meta") || s.contains("llama") {
        "meta".into()
    } else if s.contains("devin") {
        "devin".into()
    } else if s.contains("vertex") {
        "vertex".into()
    } else if s.contains("gemini") {
        // Gemini traffic often arrives via Antigravity / Vertex credentials.
        "gemini".into()
    } else if s.is_empty() {
        "other".into()
    } else {
        s
    }
}

/// CLI flag (without leading `-`) for a loginable provider.
pub fn login_flag_for(raw: &str) -> Option<&'static str> {
    find_provider(raw)
        .and_then(|p| p.login_flag.as_deref())
}
