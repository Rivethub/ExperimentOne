//! Pidfiles and single-instance lock for Rivet-owned processes.

use std::fs::{self, File, OpenOptions};
use std::path::Path;
use std::process::Command;

#[cfg(not(any(unix, windows)))]
use anyhow::Context;
use anyhow::Result;
#[cfg(unix)]
use anyhow::{bail, Context};

use crate::RivetPaths;

/// Held for the lifetime of a rivetd process — released on drop.
#[derive(Debug)]
pub struct InstanceLock {
    _file: File,
}

/// Exclusive non-blocking lock under `pids/rivetd.lock`.
pub fn try_acquire_rivetd_lock(paths: &RivetPaths) -> Result<InstanceLock> {
    let path = paths.pid_dir().join("rivetd.lock");
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    #[cfg(unix)]
    let file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(path.as_std_path())
        .with_context(|| format!("open {path}"))?;
    #[cfg(unix)]
    {
        use fs4::fs_std::FileExt;
        if file.try_lock_exclusive().is_err() {
            bail!("another rivetd is already running (pids/rivetd.lock held)");
        }
        Ok(InstanceLock { _file: file })
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // share_mode(0) = exclusive; fails if another rivetd holds the lock file.
        let file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(false)
            .share_mode(0)
            .open(path.as_std_path())
            .map_err(|_| {
                anyhow::anyhow!("another rivetd is already running (pids/rivetd.lock held)")
            })?;
        Ok(InstanceLock { _file: file })
    }
    #[cfg(not(any(unix, windows)))]
    {
        let file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(false)
            .open(path.as_std_path())
            .with_context(|| format!("open {}", path))?;
        Ok(InstanceLock { _file: file })
    }
}

pub fn write_pid(path: &Path, pid: u32) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let body = process_exe(pid).map_or_else(|| pid.to_string(), |exe| format!("{pid}\n{exe}"));
    let _ = fs::write(path, body);
}

pub fn clear_pid(path: &Path) {
    let _ = fs::remove_file(path);
}

/// Clear a pidfile only when it still records `our_pid` (avoids wiping a twin's file).
pub fn clear_pid_if_ours(path: &Path, our_pid: u32) {
    if let Some((pid, _)) = read_pidfile(path) {
        if pid == our_pid {
            clear_pid(path);
        }
    }
}

pub fn read_pidfile(path: &Path) -> Option<(u32, Option<String>)> {
    let raw = fs::read_to_string(path).ok()?;
    let mut lines = raw.lines();
    let pid: u32 = lines.next()?.trim().parse().ok()?;
    if pid == 0 {
        return None;
    }
    let expected = lines
        .next()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    Some((pid, expected))
}

pub fn process_exe(pid: u32) -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        if let Ok(link) = fs::read_link(format!("/proc/{pid}/exe")) {
            if let Ok(s) = link.into_os_string().into_string() {
                return Some(s);
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Some(p) = process_exe_lsof(pid) {
            return Some(p);
        }
    }
    #[cfg(unix)]
    {
        if let Some(p) = process_exe_from_ps(pid) {
            return Some(p);
        }
        None
    }
    #[cfg(windows)]
    {
        process_exe_windows(pid)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = pid;
        None
    }
}

#[cfg(windows)]
fn process_exe_windows(pid: u32) -> Option<String> {
    let output = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &format!("(Get-CimInstance Win32_Process -Filter \"ProcessId={pid}\").ExecutablePath"),
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}

#[cfg(target_os = "macos")]
fn process_exe_lsof(pid: u32) -> Option<String> {
    let output = Command::new("lsof")
        .args(["-p", &pid.to_string(), "-a", "-d", "txt", "-Fn"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines() {
        if let Some(path) = line.strip_prefix('n') {
            if path.starts_with('/') {
                return Some(path.to_string());
            }
        }
    }
    None
}

#[cfg(unix)]
fn process_exe_from_ps(pid: u32) -> Option<String> {
    let output = Command::new("ps")
        .args(["-p", &pid.to_string(), "-ww", "-o", "args="])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let line = String::from_utf8_lossy(&output.stdout);
    exe_from_args_line(line.trim())
}

fn looks_like_absolute_exe(line: &str) -> bool {
    if line.starts_with('/') {
        return true;
    }
    // Windows: `C:\...` or `C:/...`
    let b = line.as_bytes();
    b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/')
}

/// Recover argv0 even when the path contains spaces (e.g. `Application Support`).
pub fn exe_from_args_line(line: &str) -> Option<String> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    if !looks_like_absolute_exe(line) {
        // Quoted Windows paths: `"C:\Program Files\Rivet\rivetd.exe" ...`
        if let Some(rest) = line.strip_prefix('"') {
            if let Some(end) = rest.find('"') {
                return Some(rest[..end].to_string());
            }
        }
        return line.split_whitespace().next().map(str::to_string);
    }

    let mut best_existing: Option<String> = None;
    for (i, ch) in line.char_indices() {
        if ch == ' ' || ch == '\t' {
            let cand = &line[..i];
            if Path::new(cand).is_file() {
                best_existing = Some(cand.to_string());
            }
        }
    }
    if Path::new(line).is_file() {
        return Some(line.to_string());
    }
    if let Some(b) = best_existing {
        return Some(b);
    }

    let mut path = String::new();
    for tok in line.split_whitespace() {
        if tok.starts_with('-') && !path.is_empty() {
            break;
        }
        if !path.is_empty() {
            path.push(' ');
        }
        path.push_str(tok);
    }
    (!path.is_empty()).then_some(path)
}

pub fn identity_matches(live: &str, expected: Option<&str>, legacy_hints: &[&str]) -> bool {
    let live = live.trim();
    if live.is_empty() {
        return false;
    }
    let live_base = Path::new(live)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(live);

    if let Some(exp) = expected.map(str::trim).filter(|s| !s.is_empty()) {
        if exp.contains('/') || exp.contains('\\') {
            return live == exp;
        }
        let e = exp.to_ascii_lowercase();
        let b = live_base.to_ascii_lowercase();
        return b == e || b.starts_with(&e) || e.starts_with(&b);
    }

    let b = live_base.to_ascii_lowercase();
    legacy_hints.iter().any(|hint| {
        let h = hint.to_ascii_lowercase();
        b == h || b.starts_with(&h) || h.starts_with(&b)
    })
}

pub fn write_proxy_pid(paths: &RivetPaths, pid: u32) {
    write_pid(paths.proxy_pid_file().as_std_path(), pid);
}

pub fn clear_proxy_pid(paths: &RivetPaths) {
    clear_pid(paths.proxy_pid_file().as_std_path());
}

pub fn clear_proxy_pid_if_ours(paths: &RivetPaths, pid: u32) {
    clear_pid_if_ours(paths.proxy_pid_file().as_std_path(), pid);
}

/// Kill a stale rivet-proxy recorded in the pidfile (e.g. after rivetd crashed).
/// Only signals processes whose live exe still looks like rivet-proxy.
pub fn reclaim_proxy_orphan(paths: &RivetPaths) {
    let path = paths.proxy_pid_file();
    let Some((pid, expected)) = read_pidfile(path.as_std_path()) else {
        return;
    };
    if pid == 0 || pid == std::process::id() {
        clear_proxy_pid(paths);
        return;
    }
    let live = process_exe(pid);
    let hints = ["rivet-proxy", "CLIProxyAPI", "cliproxy"];
    let ours = match (&live, expected.as_deref()) {
        (Some(live), expected) => identity_matches(live, expected, &hints),
        (None, _) => false,
    };
    if !ours {
        // Pidfile is stale or points at something else — just clear it.
        clear_proxy_pid(paths);
        return;
    }
    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .args(["-TERM", &format!("-{pid}")])
            .status();
        std::thread::sleep(std::time::Duration::from_millis(150));
        let _ = Command::new("kill")
            .args(["-KILL", &format!("-{pid}")])
            .status();
        let _ = Command::new("kill")
            .args(["-KILL", &pid.to_string()])
            .status();
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status();
    }
    clear_proxy_pid(paths);
}

pub fn write_clickhouse_pid(paths: &RivetPaths, pid: u32) {
    write_pid(paths.clickhouse_pid_file().as_std_path(), pid);
}

pub fn clear_clickhouse_pid(paths: &RivetPaths) {
    clear_pid(paths.clickhouse_pid_file().as_std_path());
}

pub fn clear_clickhouse_pid_if_ours(paths: &RivetPaths, pid: u32) {
    clear_pid_if_ours(paths.clickhouse_pid_file().as_std_path(), pid);
}

pub fn write_rivetd_pid(paths: &RivetPaths) {
    write_pid(paths.rivetd_pid_file().as_std_path(), std::process::id());
}

pub fn clear_rivetd_pid(paths: &RivetPaths) {
    clear_pid_if_ours(paths.rivetd_pid_file().as_std_path(), std::process::id());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_expected_rejects_homebrew_clickhouse() {
        assert!(!identity_matches(
            "/opt/homebrew/bin/clickhouse",
            Some("/Users/me/Library/Application Support/Rivet/bin/clickhouse"),
            &["clickhouse"],
        ));
    }

    #[test]
    fn path_expected_accepts_exact() {
        let p = "/Users/me/Library/Application Support/Rivet/bin/clickhouse";
        assert!(identity_matches(p, Some(p), &["clickhouse"]));
    }

    #[test]
    fn short_expected_matches_basename() {
        assert!(identity_matches(
            "/tmp/rivet-proxy",
            Some("rivet-proxy"),
            &["nope"],
        ));
    }

    #[test]
    fn legacy_hints_do_not_substring_match() {
        assert!(!identity_matches(
            "/opt/homebrew/bin/my-clickhouse-helper",
            None,
            &["clickhouse"],
        ));
        assert!(identity_matches(
            "/usr/local/bin/clickhouse",
            None,
            &["clickhouse"],
        ));
    }

    #[test]
    fn exe_from_args_preserves_application_support_spaces() {
        let tmp = std::env::temp_dir().join("rivet-core-pid-test-bin");
        let nested = tmp.join("Application Support").join("Rivet").join("bin");
        let _ = fs::create_dir_all(&nested);
        let exe = nested.join("clickhouse");
        fs::write(&exe, b"#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = fs::metadata(&exe).unwrap().permissions();
            perms.set_mode(0o755);
            fs::set_permissions(&exe, perms).unwrap();
        }
        let args = format!("{} --config /tmp/x", exe.display());
        let got = exe_from_args_line(&args).expect("exe");
        assert_eq!(got, exe.to_string_lossy());
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn exe_from_args_joins_until_flag_when_missing_on_disk() {
        let got = exe_from_args_line(
            "/Users/me/Library/Application Support/Rivet/bin/clickhouse --cfg x",
        )
        .unwrap();
        assert_eq!(
            got,
            "/Users/me/Library/Application Support/Rivet/bin/clickhouse"
        );
    }

    #[test]
    fn clear_pid_if_ours_leaves_foreign() {
        let dir = std::env::temp_dir().join("rivet-core-pid-clear");
        let _ = fs::create_dir_all(&dir);
        let path = dir.join("x.pid");
        fs::write(&path, "99999\n/bin/false\n").unwrap();
        clear_pid_if_ours(&path, 1);
        assert!(path.exists());
        clear_pid_if_ours(&path, 99999);
        assert!(!path.exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
