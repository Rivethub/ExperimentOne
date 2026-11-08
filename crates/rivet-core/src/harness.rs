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
        match raw.map_or("user", str::trim).to_ascii_lowercase().as_str() {
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
    plugins_dest: &Path,
) -> Result<HarnessInstallResult> {
    let plugin_note = match install_harness_plugins(config, plugins_dest) {
        Ok(path) => format!(" Plugins ready at {}.", path.display()),
        Err(err) => format!(" Plugin install skipped: {err}."),
    };
    let mut result = match (target.trim().to_ascii_lowercase().as_str(), mode) {
        ("claude", HarnessInstallMode::User) => install_claude_user(config, plugins_dest),
        ("claude", HarnessInstallMode::Isolated) => {
            install_claude_isolated(config, isolated_claude_dir, plugins_dest)
        },
        ("codex", HarnessInstallMode::User) => install_codex_user(config, plugins_dest),
        ("codex", HarnessInstallMode::Isolated) => {
            install_codex_isolated(config, isolated_codex_dir, plugins_dest)
        },
        (other, _) => bail!("unknown harness target '{other}'"),
    }?;
    result.note.push_str(&plugin_note);
    Ok(result)
}

/// Copy the bundled Rivet marketplace into `plugins_dest` and rewrite MCP URLs.
pub fn install_harness_plugins(config: &RivetConfig, plugins_dest: &Path) -> Result<PathBuf> {
    let src = find_bundled_plugins_dir().context(
        "bundled plugins/ not found (set RIVET_PLUGINS_SRC or run from a Rivet checkout/install)",
    )?;
    copy_dir_recursive(&src, plugins_dest)
        .with_context(|| format!("copy plugins {} → {}", src.display(), plugins_dest.display()))?;
    rewrite_plugin_mcp_urls(plugins_dest, &config.mcp_url())?;
    // Ensure hook scripts are executable on Unix.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for rel in [
            "rivet/scripts/report-session.sh",
            "rivet-codex/scripts/report-session.sh",
        ] {
            let script = plugins_dest.join(rel);
            if script.is_file() {
                let mut perms = fs::metadata(&script)?.permissions();
                perms.set_mode(0o755);
                fs::set_permissions(&script, perms)?;
            }
        }
    }
    Ok(plugins_dest.to_path_buf())
}

fn find_bundled_plugins_dir() -> Option<PathBuf> {
    if let Ok(raw) = std::env::var("RIVET_PLUGINS_SRC") {
        let path = PathBuf::from(raw);
        if path.join(".claude-plugin").join("marketplace.json").is_file() {
            return Some(path);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            for cand in [parent.join("plugins"), parent.join("../plugins"), parent.join("../../plugins")]
            {
                if cand.join(".claude-plugin").join("marketplace.json").is_file() {
                    return Some(cand.canonicalize().unwrap_or(cand));
                }
            }
        }
    }
    let cargo = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let repo_plugins = cargo.join("../../plugins");
    if repo_plugins.join(".claude-plugin").join("marketplace.json").is_file() {
        return Some(repo_plugins.canonicalize().unwrap_or(repo_plugins));
    }
    None
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<()> {
    fs::create_dir_all(dst).with_context(|| format!("create {}", dst.display()))?;
    for entry in fs::read_dir(src).with_context(|| format!("read {}", src.display()))? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &to)?;
        } else if ty.is_file() {
            if let Some(parent) = to.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(entry.path(), &to)
                .with_context(|| format!("copy {} → {}", entry.path().display(), to.display()))?;
        }
    }
    Ok(())
}

fn rewrite_plugin_mcp_urls(plugins_dest: &Path, mcp_url: &str) -> Result<()> {
    let mcp_path = plugins_dest.join("rivet").join(".mcp.json");
    if !mcp_path.is_file() {
        return Ok(());
    }
    let raw = fs::read_to_string(&mcp_path)?;
    let mut root: Value = serde_json::from_str(&raw).unwrap_or_else(|_| json!({}));
    if let Some(servers) = root.get_mut("mcpServers").and_then(|v| v.as_object_mut()) {
        if let Some(rivet) = servers.get_mut("rivet").and_then(|v| v.as_object_mut()) {
            rivet.insert("url".into(), Value::String(mcp_url.to_string()));
        }
    }
    fs::write(&mcp_path, format!("{}\n", serde_json::to_string_pretty(&root)?))?;
    Ok(())
}

fn install_claude_isolated(
    config: &RivetConfig,
    dir: &Path,
    plugins_dest: &Path,
) -> Result<HarnessInstallResult> {
    fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
    let path = dir.join("settings.json");
    let merged = merge_claude_settings("{}", config, Some(plugins_dest))?;
    fs::write(&path, merged)?;
    Ok(HarnessInstallResult {
        target: "claude".into(),
        path: path.display().to_string(),
        backup_path: None,
        env_hint: format!(
            "CLAUDE_CONFIG_DIR={}",
            shell_quote(&dir.display().to_string())
        ),
        note: "Wrote an isolated Claude config with Rivet plugin + MCP. Set CLAUDE_CONFIG_DIR to that path before launching Claude Code (default install untouched).".into(),
    })
}

fn install_codex_isolated(
    config: &RivetConfig,
    dir: &Path,
    plugins_dest: &Path,
) -> Result<HarnessInstallResult> {
    fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
    let path = dir.join("config.toml");
    let merged = merge_codex_config("", config, Some(plugins_dest));
    fs::write(&path, merged)?;
    write_codex_hooks(dir, plugins_dest)?;
    Ok(HarnessInstallResult {
        target: "codex".into(),
        path: path.display().to_string(),
        backup_path: None,
        env_hint: format!("CODEX_HOME={}", shell_quote(&dir.display().to_string())),
        note: "Wrote an isolated Codex home with Rivet MCP + session hooks. Set CODEX_HOME to that path before launching Codex (default install untouched).".into(),
    })
}

fn install_claude_user(config: &RivetConfig, plugins_dest: &Path) -> Result<HarnessInstallResult> {
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
    let merged = merge_claude_settings(&existing, config, Some(plugins_dest))?;
    fs::write(&path, merged).with_context(|| format!("write {}", path.display()))?;
    let backup_note =
        backup_path.as_ref().map(|b| format!(" Backup saved to {b}.")).unwrap_or_default();
    Ok(HarnessInstallResult {
        target: "claude".into(),
        path: path.display().to_string(),
        backup_path,
        env_hint: String::new(),
        note: format!(
            "Merged Rivet proxy, MCP, and rivet@rivet plugin into your Claude Code settings.json. Restart Claude Code to pick them up.{backup_note}"
        ),
    })
}

fn install_codex_user(config: &RivetConfig, plugins_dest: &Path) -> Result<HarnessInstallResult> {
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
    let merged = merge_codex_config(&existing, config, Some(plugins_dest));
    fs::write(&path, merged).with_context(|| format!("write {}", path.display()))?;
    if let Some(home) = path.parent() {
        write_codex_hooks(home, plugins_dest)?;
    }
    let backup_note =
        backup_path.as_ref().map(|b| format!(" Backup saved to {b}.")).unwrap_or_default();
    Ok(HarnessInstallResult {
        target: "codex".into(),
        path: path.display().to_string(),
        backup_path,
        env_hint: String::new(),
        note: format!(
            "Merged Rivet as the Codex model provider with MCP + session hooks. Restart Codex to pick it up.{backup_note}"
        ),
    })
}

fn write_codex_hooks(codex_home: &Path, plugins_dest: &Path) -> Result<()> {
    let script = plugins_dest.join("rivet-codex").join("scripts").join("report-session.sh");
    if !script.is_file() {
        return Ok(());
    }
    let hooks_path = codex_home.join("hooks.json");
    let hooks = json!({
        "hooks": {
            "SessionStart": [{
                "hooks": [{
                    "type": "command",
                    "command": script.display().to_string()
                }]
            }]
        }
    });
    fs::write(&hooks_path, format!("{}\n", serde_json::to_string_pretty(&hooks)?))?;
    Ok(())
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
    let file_name = path.file_name().and_then(|s| s.to_str()).unwrap_or("config");
    let backup = path.with_file_name(format!("{file_name}.rivet-backup-{stamp}"));
    fs::copy(path, &backup)
        .with_context(|| format!("backup {} → {}", path.display(), backup.display()))?;
    Ok(Some(backup.display().to_string()))
}

/// Merge Rivet env + MCP + optional local marketplace plugin into Claude settings.
///
/// Sets `ANTHROPIC_BASE_URL` and clears gateway auth env vars so Claude Code
/// keeps claude.ai connectors enabled.
pub fn merge_claude_settings(
    existing: &str,
    config: &RivetConfig,
    plugins_dest: Option<&Path>,
) -> Result<String> {
    let mut root: Value = if existing.trim().is_empty() {
        json!({})
    } else {
        serde_json::from_str(existing).context("parse Claude settings.json")?
    };
    if !root.is_object() {
        bail!("Claude settings.json root must be a JSON object");
    }

    let obj = root.as_object_mut().expect("object");
    let env = obj.entry("env").or_insert_with(|| Value::Object(Map::new()));
    if !env.is_object() {
        *env = Value::Object(Map::new());
    }
    let env_obj = env.as_object_mut().expect("env object");
    env_obj.insert("ANTHROPIC_BASE_URL".into(), Value::String(config.proxy_base_url()));
    env_obj.insert("RIVET_API_BASE".into(), Value::String(config.api_base_url()));
    // Richer wire headers for Rivet capture when pointed at a custom base URL.
    env_obj.insert("CLAUDE_CODE_GATEWAY_HINT_HEADERS".into(), Value::String("1".into()));
    // Anthropic disables claude.ai connectors when these are set.
    env_obj.remove("ANTHROPIC_AUTH_TOKEN");
    env_obj.remove("ANTHROPIC_API_KEY");

    let mcp = obj.entry("mcpServers").or_insert_with(|| Value::Object(Map::new()));
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

    if let Some(plugins_dest) = plugins_dest {
        let marketplace_path = plugins_dest
            .canonicalize()
            .unwrap_or_else(|_| plugins_dest.to_path_buf())
            .display()
            .to_string();
        let markets =
            obj.entry("extraKnownMarketplaces").or_insert_with(|| Value::Object(Map::new()));
        if !markets.is_object() {
            *markets = Value::Object(Map::new());
        }
        markets.as_object_mut().expect("markets").insert(
            "rivet".into(),
            json!({
                "source": {
                    "source": "directory",
                    "path": marketplace_path,
                }
            }),
        );
        let enabled = obj.entry("enabledPlugins").or_insert_with(|| Value::Object(Map::new()));
        if !enabled.is_object() {
            *enabled = Value::Object(Map::new());
        }
        enabled.as_object_mut().expect("enabled").insert("rivet@rivet".into(), Value::Bool(true));
    }

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
    let base = env.get("ANTHROPIC_BASE_URL").and_then(|v| v.as_str()).unwrap_or("");
    if base != config.proxy_base_url() {
        return Ok(false);
    }
    let had_auth =
        env.contains_key("ANTHROPIC_AUTH_TOKEN") || env.contains_key("ANTHROPIC_API_KEY");
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

/// Overlay Rivet provider + MCP into an existing Codex `config.toml`.
pub fn merge_codex_config(
    existing: &str,
    config: &RivetConfig,
    _plugins_dest: Option<&Path>,
) -> String {
    let rivet_block = format!(
        r#"model_provider = "rivet"

[model_providers.rivet]
name = "Rivet"
base_url = "{}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = true
experimental_bearer_token = "{}"

[mcp_servers.rivet]
url = "{}"
"#,
        config.proxy_base_url(),
        config.proxy_access_key,
        config.mcp_url(),
    );

    let stripped = strip_codex_rivet_sections(existing);
    let mut out = if stripped.trim().is_empty() {
        rivet_block
    } else {
        format!("{}\n{}\n", rivet_block.trim_end(), stripped.trim_start())
    };
    out = ensure_codex_hooks_feature(&out);
    out
}

fn ensure_codex_hooks_feature(input: &str) -> String {
    if input.lines().any(|l| {
        let t = l.trim();
        t.starts_with("hooks") && t.contains('=') && t.to_ascii_lowercase().contains("true")
    }) {
        return input.to_string();
    }
    if let Some(idx) = input.lines().position(|l| l.trim().eq_ignore_ascii_case("[features]")) {
        let mut lines: Vec<String> = input.lines().map(str::to_string).collect();
        lines.insert(idx + 1, "hooks = true".into());
        let mut out = lines.join("\n");
        if !input.ends_with('\n') {
            // keep prior trailing newline habit
        }
        out.push('\n');
        return out;
    }
    format!("{input}\n[features]\nhooks = true\n")
}

/// Remove prior Rivet-managed keys/sections so reinstall is idempotent.
fn strip_codex_rivet_sections(input: &str) -> String {
    let mut out = String::new();
    let mut skip_section = false;
    for line in input.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            skip_section = trimmed.eq_ignore_ascii_case("[model_providers.rivet]")
                || trimmed.eq_ignore_ascii_case("[mcp_servers.rivet]");
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
        let plugins = std::env::temp_dir().join(format!("rivet-plugins-{}", Uuid::new_v4()));
        let _ = fs::create_dir_all(&plugins);
        let out = merge_claude_settings(existing, &cfg(), Some(&plugins)).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["theme"], "dark");
        assert_eq!(v["env"]["KEEP_ME"], "1");
        assert_eq!(v["env"]["ANTHROPIC_BASE_URL"], "http://127.0.0.1:18317");
        assert_eq!(v["env"]["RIVET_API_BASE"], "http://127.0.0.1:8741");
        assert_eq!(v["env"]["CLAUDE_CODE_GATEWAY_HINT_HEADERS"], "1");
        assert!(v["env"].get("ANTHROPIC_AUTH_TOKEN").is_none());
        assert!(v["env"].get("ANTHROPIC_API_KEY").is_none());
        assert_eq!(v["mcpServers"]["other"]["command"], "x");
        assert_eq!(v["mcpServers"]["rivet"]["url"], "http://127.0.0.1:8742/mcp");
        assert_eq!(v["enabledPlugins"]["rivet@rivet"], true);
        assert!(v["extraKnownMarketplaces"]["rivet"]["source"]["path"]
            .as_str()
            .unwrap()
            .contains("rivet-plugins-"));
        let _ = fs::remove_dir_all(&plugins);
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
        let out = merge_codex_config(existing, &cfg(), None);
        assert!(out.contains("model_provider = \"rivet\""));
        assert!(out.contains("experimental_bearer_token = \"rivet_test_key\""));
        assert!(out.contains("[model_providers.openai]"));
        assert!(out.contains("notify = true"));
        assert!(out.contains("[mcp_servers.rivet]"));
        assert!(out.contains("hooks = true"));
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
            merge_claude_settings(&fs::read_to_string(&settings).unwrap(), &cfg(), None).unwrap();
        fs::write(&settings, merged).unwrap();
        let v: Value = serde_json::from_str(&fs::read_to_string(&settings).unwrap()).unwrap();
        assert_eq!(v["theme"], "light");
        assert_eq!(v["env"]["ANTHROPIC_BASE_URL"], "http://127.0.0.1:18317");
        assert!(v["env"].get("ANTHROPIC_AUTH_TOKEN").is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn install_plugins_copies_marketplace() {
        let dest = std::env::temp_dir().join(format!("rivet-plugdest-{}", Uuid::new_v4()));
        let _ = fs::remove_dir_all(&dest);
        let path = install_harness_plugins(&cfg(), &dest).expect("copy plugins");
        assert!(path.join(".claude-plugin").join("marketplace.json").is_file());
        assert!(path.join("rivet").join("scripts").join("report-session.sh").is_file());
        let mcp: Value = serde_json::from_str(
            &fs::read_to_string(path.join("rivet").join(".mcp.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(mcp["mcpServers"]["rivet"]["url"], "http://127.0.0.1:8742/mcp");
        let _ = fs::remove_dir_all(&dest);
    }
}
