//! Install-root layout for the headless Rivet bundle.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use rivet_core::{exe_name, target_triple};

/// Default GitHub repo that publishes headless release archives.
pub const DEFAULT_GITHUB_REPO: &str = "wSedlacek/Rivet";

pub fn github_repo() -> String {
    std::env::var("RIVET_GITHUB_REPO").unwrap_or_else(|_| DEFAULT_GITHUB_REPO.into())
}

/// Root where release binaries are unpacked (`…/rivet/install`).
pub fn install_root() -> Result<PathBuf> {
    if let Ok(explicit) = std::env::var("RIVET_INSTALL_DIR") {
        return Ok(PathBuf::from(explicit));
    }
    let base = dirs::data_local_dir().context("no local data dir")?;
    Ok(base.join("rivet").join("install"))
}

pub fn bin_dir() -> Result<PathBuf> {
    Ok(install_root()?.join("bin"))
}

pub fn version_file() -> Result<PathBuf> {
    Ok(install_root()?.join("VERSION"))
}

pub fn installed_version() -> Option<String> {
    let path = version_file().ok()?;
    fs::read_to_string(path).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

pub fn ensure_install_dirs() -> Result<PathBuf> {
    let root = install_root()?;
    fs::create_dir_all(root.join("bin")).with_context(|| format!("create {}", root.display()))?;
    Ok(root)
}

/// Preferred path for the CLI on the user's PATH (`~/.local/bin/rivet`).
pub fn user_bin_dir() -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("RIVET_USER_BIN") {
        return Some(PathBuf::from(explicit));
    }
    dirs::home_dir().map(|h| h.join(".local").join("bin"))
}

pub fn installed_bin(name: &str) -> Result<PathBuf> {
    Ok(bin_dir()?.join(exe_name(name)))
}

/// Resolve a runtime binary: env override → install root → RIVET_BIN_DIR →
/// sidecar next to this CLI → cargo/dev sidecars → PATH.
pub fn resolve_runtime_bin(base: &str) -> Option<PathBuf> {
    let env_key = match base {
        "rivetd" => "RIVETD_BIN",
        "rivet-proxy" => "RIVET_PROXY_BIN",
        "clickhouse" => "RIVET_CLICKHOUSE_BIN",
        _ => "",
    };
    if !env_key.is_empty() {
        if let Ok(p) = std::env::var(env_key) {
            let path = PathBuf::from(p);
            if path.is_file() {
                return Some(path);
            }
        }
    }

    if let Ok(p) = installed_bin(base) {
        if p.is_file() {
            return Some(p);
        }
    }

    if let Ok(dir) = std::env::var("RIVET_BIN_DIR") {
        let dir = PathBuf::from(dir);
        for candidate in [
            dir.join(exe_name(base)),
            dir.join(format!("{base}-{}", target_triple())),
            dir.join(format!("{}-{}{}", base, target_triple(), rivet_core::exe_suffix())),
        ] {
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for candidate in [
                dir.join(exe_name(base)),
                dir.join(format!("{}-{}{}", base, target_triple(), rivet_core::exe_suffix())),
            ] {
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }

    for rel in [
        PathBuf::from("apps/desktop/src-tauri/binaries"),
        PathBuf::from("target/release"),
        PathBuf::from("target/debug"),
    ] {
        if let Ok(cwd) = std::env::current_dir() {
            let dir = cwd.join(&rel);
            for candidate in [
                dir.join(exe_name(base)),
                dir.join(format!("{}-{}{}", base, target_triple(), rivet_core::exe_suffix())),
            ] {
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }

    rivet_core::which_bin(base)
}

pub fn path_display(p: &Path) -> String {
    p.display().to_string()
}
