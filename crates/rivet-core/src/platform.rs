//! Host triple and PATH helpers shared by runtime + desktop.

use std::path::{Path, PathBuf};

/// Rustc host/target triple used for Tauri `externalBin` sidecar names.
pub fn target_triple() -> &'static str {
    if let Some(t) = option_env!("TARGET") {
        return t;
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "aarch64-apple-darwin"
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        "x86_64-apple-darwin"
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        "x86_64-unknown-linux-gnu"
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        "aarch64-unknown-linux-gnu"
    }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        "x86_64-pc-windows-msvc"
    }
    #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
    {
        "aarch64-pc-windows-msvc"
    }
    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "aarch64"),
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "windows", target_arch = "aarch64"),
    )))]
    {
        "unknown"
    }
}

/// `.exe` on Windows, empty elsewhere.
pub fn exe_suffix() -> &'static str {
    if cfg!(windows) {
        ".exe"
    } else {
        ""
    }
}

/// Tauri externalBin file name: `rivetd-x86_64-pc-windows-msvc.exe`.
pub fn sidecar_file_name(base: &str) -> String {
    format!("{base}-{}{}", target_triple(), exe_suffix())
}

/// Bare executable name for PATH lookups (`rivetd` / `rivetd.exe`).
pub fn exe_name(base: &str) -> String {
    format!("{base}{}", exe_suffix())
}

/// Search `PATH` for `base` (and `base.exe` on Windows).
pub fn which_bin(base: &str) -> Option<PathBuf> {
    let names = {
        #[cfg(windows)]
        {
            let mut v = vec![exe_name(base), base.to_string()];
            if let Ok(pathext) = std::env::var("PATHEXT") {
                for ext in pathext.split(';') {
                    let ext = ext.trim();
                    if ext.is_empty() {
                        continue;
                    }
                    let name = if ext.starts_with('.') {
                        format!("{base}{ext}")
                    } else {
                        format!("{base}.{ext}")
                    };
                    if !v.iter().any(|n| n.eq_ignore_ascii_case(&name)) {
                        v.push(name);
                    }
                }
            }
            v
        }
        #[cfg(not(windows))]
        {
            vec![base.to_string()]
        }
    };

    std::env::var_os("PATH").and_then(|paths| {
        for dir in std::env::split_paths(&paths) {
            for name in &names {
                let p = dir.join(name);
                if p.is_file() {
                    return Some(p);
                }
            }
        }
        None
    })
}

/// Resolve a Tauri-style sidecar next to `current_exe`, under `binaries/`, or on PATH.
pub fn resolve_sidecar(base: &str, env_var: &str) -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var(env_var) {
        let p = PathBuf::from(explicit);
        if p.is_file() {
            return Some(p);
        }
    }

    let named = sidecar_file_name(base);
    let plain = exe_name(base);

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for candidate in [
                dir.join(&named),
                dir.join(&plain),
                dir.join(base),
                dir.join("binaries").join(&named),
                dir.join("binaries").join(&plain),
            ] {
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }

    which_bin(base)
}

pub fn path_is_file(p: &Path) -> bool {
    p.is_file()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn triple_is_known() {
        assert_ne!(target_triple(), "unknown");
    }

    #[test]
    fn sidecar_name_includes_triple() {
        let name = sidecar_file_name("rivetd");
        assert!(name.contains(target_triple()), "{name}");
        #[cfg(windows)]
        assert!(name.ends_with(".exe"), "{name}");
        #[cfg(not(windows))]
        assert!(!name.ends_with(".exe"), "{name}");
    }
}
