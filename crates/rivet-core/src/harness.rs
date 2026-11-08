//! Install Rivet proxy settings into Claude Code / Codex harness configs.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use chrono::Utc;
use serde_json::{json, Map, Value};

use crate::config::RivetConfig;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HarnessInstallMode {
    /// Merge into the user's default Claude/Codex config (with backup).
    User,
    /// Write an isolated Rivet-owned config dir (requires env override to use).
    Isolated,
}

impl HarnessInstallMode {
    pub fn parse(raw: Option<&str>) -> Self {
        match raw
            .map(str::trim)
            .unwrap_or("user")
            .to_ascii_lowercase()
            .as_str()
        {
            "isolated" | "dir" | "sidecar" => Self::Isolated,
            _ => Self::User,
        }
    }
}

#[derive(Debug, Clone)]
pub struct HarnessInstallResult {
    pub target: String,
    pub path: String,
    pub backup_path: Option<String>,
    pub env_hint: String,
    pub note: String,
}

/// Map a Rivet provider id to a harness install target (`claude` / `codex`).
pub fn harness_target_for_provider(provider: &str) -> Option<&'static str> {
    match crate::providers::normalize_provider_id(provider).as_str() {
        "claude" => Some("claude"),
        "codex" | "openai" => Some("codex"),
        _ => None,
    }
}

/// True when the user's default Claude or Codex config already points at Rivet.
pub fn harness_user_ready() -> bool {
    claude_user_has_rivet() || codex_user_has_rivet()
}

fn claude_user_has_rivet() -> bool {
    let Ok(path) = claude_user_settings_path() else {
        return false;
    };
    let Ok(raw) = fs::read_to_string(path) else {
        return false;
    };
    raw.contains("ANTHROPIC_BASE_URL")
}

fn codex_user_has_rivet() -> bool {
    let Ok(path) = codex_user_config_path() else {
        return false;
    };
    let Ok(raw) = fs::read_to_string(path) else {
        return false;
    };
    raw.contains("[model_providers.rivet]") && raw.contains("model_provider = \"rivet\"")
}

pub fn install_harness(
    target: &str,
    mode: HarnessInstallMode,
    config: &RivetConfig,
    isolated_claude_dir: &Path,
    isolated_codex_dir: &Path,
) -> Result<HarnessInstallResult> {
    match (target.trim().to_ascii_lowercase().as_str(), mode) {
        ("claude", HarnessInstallMode::User) => install_claude_user(config),
        ("claude", HarnessInstallMode::Isolated) => {
            install_claude_isolated(config, isolated_claude_dir)
        }
        ("codex", HarnessInstallMode::User) => install_codex_user(config),
        ("codex", HarnessInstallMode::Isolated) => {
            install_codex_isolated(config, isolated_codex_dir)
        }
        (other, _) => bail!("unknown harness target '{other}'"),
    }
}

fn install_claude_isolated(config: &RivetConfig, dir: &Path) -> Result<HarnessInstallResult> {
    fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
    let path = dir.join("settings.json");
    fs::write(&path, crate::proxy_config::claude_settings_json(config))?;
    Ok(HarnessInstallResult {
        target: "claude".into(),
        path: path.display().to_string(),
        backup_path: None,
        env_hint: format!(
            "CLAUDE_CONFIG_DIR={}",
            shell_quote(&dir.display().to_string())
        ),
        note: "Wrote an isolated Claude config. Set CLAUDE_CONFIG_DIR to that path before launching Claude Code (default install untouched).".into(),
    })
}

fn install_codex_isolated(config: &RivetConfig, dir: &Path) -> Result<HarnessInstallResult> {
    fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
    let path = dir.join("config.toml");
    fs::write(&path, crate::proxy_config::codex_config_toml(config))?;
    Ok(HarnessInstallResult {
        target: "codex".into(),
        path: path.display().to_string(),
        backup_path: None,
        env_hint: format!("CODEX_HOME={}", shell_quote(&dir.display().to_string())),
        note: "Wrote an isolated Codex home. Set CODEX_HOME to that path before launching Codex (default install untouched).".into(),
    })
}

fn install_claude_user(config: &RivetConfig) -> Result<HarnessInstallResult> {
    let path = claude_user_settings_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    let backup_path = backup_if_exists(&path)?;
    let existing = if path.exists() {
        fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?
    } else {
        String::new()
    };
    let merged = merge_claude_settings(&existing, config)?;
    fs::write(&path, merged).with_context(|| format!("write {}", path.display()))?;
    let backup_note = backup_path
        .as_ref()
        .map(|b| format!(" Backup saved to {b}."))
        .unwrap_or_default();
    Ok(HarnessInstallResult {
        target: "claude".into(),
        path: path.display().to_string(),
        backup_path,
        env_hint: String::new(),
        note: format!(
            "Merged Rivet into your Claude Code settings.json. Restart Claude Code to pick them up.{backup_note}"
        ),
    })
}

fn install_codex_user(config: &RivetConfig) -> Result<HarnessInstallResult> {
    let path = codex_user_config_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    let backup_path = backup_if_exists(&path)?;
    let existing = if path.exists() {
        fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?
    } else {
        String::new()
    };
    let merged = merge_codex_config(&existing, config);
    fs::write(&path, merged).with_context(|| format!("write {}", path.display()))?;
    let backup_note = backup_path
        .as_ref()
        .map(|b| format!(" Backup saved to {b}."))
        .unwrap_or_default();
    Ok(HarnessInstallResult {
        target: "codex".into(),
        path: path.display().to_string(),
        backup_path,
        env_hint: String::new(),
        note: format!(
            "Merged Rivet as the Codex model provider into your config.toml. Restart Codex to pick it up.{backup_note}"
        ),
    })
}

pub fn claude_user_settings_path() -> Result<PathBuf> {
    let home = dirs::home_dir().context("no home directory")?;
    Ok(home.join(".claude").join("settings.json"))
}

pub fn codex_user_config_path() -> Result<PathBuf> {
    let home = dirs::home_dir().context("no home directory")?;
    Ok(home.join(".codex").join("config.toml"))
}

fn backup_if_exists(path: &Path) -> Result<Option<String>> {
    if !path.exists() {
        return Ok(None);
    }
    let stamp = Utc::now().format("%Y%m%d-%H%M%S");
    let file_name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("config");
    let backup = path.with_file_name(format!("{file_name}.rivet-backup-{stamp}"));
    fs::copy(path, &backup)
        .with_context(|| format!("backup {} → {}", path.display(), backup.display()))?;
    Ok(Some(backup.display().to_string()))
}

/// Merge Rivet env + MCP into an existing Claude `settings.json` body.
///
/// Sets only `ANTHROPIC_BASE_URL` and clears gateway auth env vars so Claude Code
/// keeps claude.ai connectors enabled.
pub fn merge_claude_settings(existing: &str, config: &RivetConfig) -> Result<String> {
    let mut root: Value = if existing.trim().is_empty() {
        json!({})
    } else {
        serde_json::from_str(existing).context("parse Claude settings.json")?
    };
    if !root.is_object() {
        bail!("Claude settings.json root must be a JSON object");
    }

    let obj = root.as_object_mut().expect("object");
    let env = obj
        .entry("env")
        .or_insert_with(|| Value::Object(Map::new()));
    if !env.is_object() {
        *env = Value::Object(Map::new());
    }
    let env_obj = env.as_object_mut().expect("env object");
    env_obj.insert(
        "ANTHROPIC_BASE_URL".into(),
        Value::String(config.proxy_base_url()),
    );
    // Anthropic disables claude.ai connectors when these are set.
    env_obj.remove("ANTHROPIC_AUTH_TOKEN");
    env_obj.remove("ANTHROPIC_API_KEY");

    let mcp = obj
        .entry("mcpServers")
        .or_insert_with(|| Value::Object(Map::new()));
    if !mcp.is_object() {
        *mcp = Value::Object(Map::new());
    }
    let mcp_obj = mcp.as_object_mut().expect("mcp object");
    mcp_obj.insert(
        "rivet".into(),
        json!({
            "type": "http",
            "url": config.mcp_url(),
        }),
    );

    Ok(format!("{}\n", serde_json::to_string_pretty(&root)?))
}

/// If a Claude `settings.json` points at Rivet but still sets
/// `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY`, strip those keys in place so
/// connectors stay enabled without re-running harness install.
pub fn migrate_claude_settings_file(path: &Path, config: &RivetConfig) -> Result<bool> {
    if !path.exists() {
        return Ok(false);
    }
    let existing = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    let Ok(mut root) = serde_json::from_str::<Value>(&existing) else {
        return Ok(false);
    };
    let Some(obj) = root.as_object_mut() else {
        return Ok(false);
    };
    let Some(env) = obj.get_mut("env").and_then(|v| v.as_object_mut()) else {
        return Ok(false);
    };
    let base = env
        .get("ANTHROPIC_BASE_URL")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if base != config.proxy_base_url() {
        return Ok(false);
    }
    let had_auth = env.contains_key("ANTHROPIC_AUTH_TOKEN") || env.contains_key("ANTHROPIC_API_KEY");
    if !had_auth {
        return Ok(false);
    }
    env.remove("ANTHROPIC_AUTH_TOKEN");
    env.remove("ANTHROPIC_API_KEY");
    let merged = format!("{}\n", serde_json::to_string_pretty(&root)?);
    fs::write(path, merged).with_context(|| format!("write {}", path.display()))?;
    Ok(true)
}

/// Migrate the user's default Claude settings (and optional isolated Rivet copy).
pub fn migrate_claude_connector_auth(
    config: &RivetConfig,
    isolated_claude_settings: Option<&Path>,
) -> Result<bool> {
    let mut changed = migrate_claude_settings_file(&claude_user_settings_path()?, config)?;
    if let Some(path) = isolated_claude_settings {
        changed |= migrate_claude_settings_file(path, config)?;
    }
    Ok(changed)
}

/// Overlay Rivet provider block into an existing Codex `config.toml`.
pub fn merge_codex_config(existing: &str, config: &RivetConfig) -> String {
    let rivet_block = format!(
        r#"model_provider = "rivet"

[model_providers.rivet]
name = "Rivet"
base_url = "{}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = true
experimental_bearer_token = "{}"
"#,
        config.proxy_base_url(),
        config.proxy_access_key
    );

    let stripped = strip_codex_rivet_sections(existing);
    if stripped.trim().is_empty() {
        rivet_block
    } else {
        format!("{}\n{}\n", rivet_block.trim_end(), stripped.trim_start())
    }
}

/// Remove prior Rivet-managed keys/sections so reinstall is idempotent.
fn strip_codex_rivet_sections(input: &str) -> String {
    let mut out = String::new();
    let mut skip_section = false;
    for line in input.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            skip_section = trimmed.eq_ignore_ascii_case("[model_providers.rivet]");
            if skip_section {
                continue;
            }
        }
        if skip_section {
            continue;
        }
        // Drop top-level model_provider assignments — we rewrite them.
        if trimmed.starts_with("model_provider")
            && trimmed.contains('=')
            && !trimmed.starts_with('[')
        {
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    out
}

fn shell_quote(path: &str) -> String {
    #[cfg(windows)]
    {
        format!("\"{}\"", path.replace('"', "\"\""))
    }
    #[cfg(not(windows))]
    {
        format!("'{}'", path.replace('\'', "'\"'\"'"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::RivetConfig;
    use uuid::Uuid;

    fn cfg() -> RivetConfig {
        RivetConfig {
            api_port: 8741,
            proxy_port: 18317,
            proxy_access_key: "rivet_test_key".into(),
            ..Default::default()
        }
    }

    #[test]
    fn provider_maps_to_harness() {
        assert_eq!(harness_target_for_provider("claude"), Some("claude"));
        assert_eq!(harness_target_for_provider("codex"), Some("codex"));
        assert_eq!(harness_target_for_provider("openai"), Some("codex"));
        assert_eq!(harness_target_for_provider("gemini"), None);
    }

    #[test]
    fn claude_merge_preserves_other_keys() {
        let existing = r#"{
  "theme": "dark",
  "env": { "KEEP_ME": "1", "ANTHROPIC_BASE_URL": "old" },
  "mcpServers": { "other": { "type": "stdio", "command": "x" } }
}"#;
        let out = merge_claude_settings(existing, &cfg()).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["theme"], "dark");
        assert_eq!(v["env"]["KEEP_ME"], "1");
        assert_eq!(v["env"]["ANTHROPIC_BASE_URL"], "http://127.0.0.1:18317");
        assert!(v["env"].get("ANTHROPIC_AUTH_TOKEN").is_none());
        assert!(v["env"].get("ANTHROPIC_API_KEY").is_none());
        assert_eq!(v["mcpServers"]["other"]["command"], "x");
        assert_eq!(v["mcpServers"]["rivet"]["url"], "http://127.0.0.1:8742/mcp");
    }

    #[test]
    fn codex_merge_replaces_rivet_and_keeps_rest() {
        let existing = r#"
model_provider = "openai"
notify = true

[model_providers.openai]
name = "OpenAI"

[model_providers.rivet]
name = "stale"
base_url = "http://old"

[features]
foo = true
"#;
        let out = merge_codex_config(existing, &cfg());
        assert!(out.contains("model_provider = \"rivet\""));
        assert!(out.contains("experimental_bearer_token = \"rivet_test_key\""));
        assert!(out.contains("[model_providers.openai]"));
        assert!(out.contains("notify = true"));
        assert!(out.contains("[features]"));
        assert!(!out.contains("http://old"));
        assert_eq!(out.matches("[model_providers.rivet]").count(), 1);
        assert!(!out.contains("model_provider = \"openai\""));
    }

    #[test]
    fn backup_and_user_install_roundtrip() {
        let dir = std::env::temp_dir().join(format!("rivet-harness-{}", Uuid::new_v4()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let settings = dir.join("settings.json");
        fs::write(&settings, r#"{"theme":"light"}"#).unwrap();
        let bak = backup_if_exists(&settings).unwrap().expect("backup");
        assert!(PathBuf::from(&bak).exists());
        let merged =
            merge_claude_settings(&fs::read_to_string(&settings).unwrap(), &cfg()).unwrap();
        fs::write(&settings, merged).unwrap();
        let v: Value = serde_json::from_str(&fs::read_to_string(&settings).unwrap()).unwrap();
        assert_eq!(v["theme"], "light");
        assert_eq!(v["env"]["ANTHROPIC_BASE_URL"], "http://127.0.0.1:18317");
        assert!(v["env"].get("ANTHROPIC_AUTH_TOKEN").is_none());
        let _ = fs::remove_dir_all(&dir);
    }
}
