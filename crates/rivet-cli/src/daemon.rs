//! Start / stop the local `rivetd` control plane.

use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use rivet_core::{exe_name, RivetPaths};

use crate::client::ApiClient;
use crate::paths::{path_display, resolve_runtime_bin};

pub async fn is_running(client: &ApiClient) -> bool {
    client.status_up().await
}

pub async fn start(client: &mut ApiClient, wait_secs: u64) -> Result<PathBuf> {
    if is_running(client).await {
        eprintln!("rivetd already running at {}", client.base());
        return Ok(resolve_runtime_bin("rivetd").unwrap_or_else(|| PathBuf::from("rivetd")));
    }

    let bin = resolve_runtime_bin("rivetd").ok_or_else(|| {
        anyhow::anyhow!(
            "rivetd not found — run `rivet install` (or set RIVETD_BIN / RIVET_BIN_DIR)"
        )
    })?;

    // Ensure ClickHouse can be found next to rivetd when bundled.
    if let Some(dir) = bin.parent() {
        if std::env::var_os("RIVET_CLICKHOUSE_BIN").is_none() {
            let ch = dir.join(exe_name("clickhouse"));
            if ch.is_file() {
                std::env::set_var("RIVET_CLICKHOUSE_BIN", &ch);
            }
        }
        if std::env::var_os("RIVET_PROXY_BIN").is_none() {
            let proxy = dir.join(exe_name("rivet-proxy"));
            if proxy.is_file() {
                std::env::set_var("RIVET_PROXY_BIN", &proxy);
            }
        }
    }

    eprintln!("Starting {}…", path_display(&bin));
    let mut cmd = Command::new(&bin);
    cmd.stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(unix)]
    {
        // Detach from the CLI session so logout does not take rivetd with it.
        use std::os::unix::process::CommandExt;
        unsafe {
            cmd.pre_exec(|| {
                if libc_setsid() == -1 {
                    // Non-fatal: still spawn.
                }
                Ok(())
            });
        }
    }
    cmd.spawn().with_context(|| format!("spawn {}", path_display(&bin)))?;

    let deadline = std::time::Instant::now() + Duration::from_secs(wait_secs.max(1));
    while std::time::Instant::now() < deadline {
        if is_running(client).await {
            eprintln!("rivetd ready at {}", client.base());
            return Ok(bin);
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }

    bail!(
        "rivetd did not become ready at {} within {wait_secs}s — check logs under the Rivet data directory",
        client.base()
    );
}

pub async fn stop(client: &mut ApiClient) -> Result<()> {
    if is_running(client).await {
        match client.post_value("/v1/shutdown", None).await {
            Ok(v) => {
                eprintln!("shutdown: {v}");
            },
            Err(err) => {
                eprintln!("shutdown request failed ({err}); falling back to pidfile");
            },
        }
        // Give rivetd a moment to exit cleanly.
        for _ in 0..25 {
            if !is_running(client).await {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    // Only signal PIDs Rivet wrote under the local data dir.
    let paths = RivetPaths::discover().context("discover Rivet data dir")?;
    let targets: &[(&str, &[&str])] = &[
        ("rivet-proxy.pid", &["rivet-proxy", "rivet-pro", "cli-proxy", "cliproxy"]),
        ("clickhouse.pid", &["clickhouse", "clickhous"]),
        ("rivetd.pid", &["rivetd"]),
    ];
    for (name, hints) in targets {
        let path = paths.pid_dir().join(name);
        if let Some((pid, expected)) = rivet_core::pids::read_pidfile(path.as_std_path()) {
            signal_owned_pid(pid, expected.as_deref(), hints);
            let _ = fs::remove_file(path.as_std_path());
        }
    }

    if is_running(client).await {
        bail!("rivetd still responding at {} after stop", client.base());
    }
    eprintln!("rivetd stopped");
    Ok(())
}

fn signal_owned_pid(pid: u32, expected: Option<&str>, hints: &[&str]) {
    let Some(live) = rivet_core::pids::process_exe(pid) else {
        return;
    };
    if !rivet_core::pids::identity_matches(&live, expected, hints) {
        eprintln!("skipping stale pidfile pid={pid} live={live} expected={expected:?}");
        return;
    }
    #[cfg(unix)]
    {
        let _ = Command::new("kill").args(["-TERM", &pid.to_string()]).status();
        for _ in 0..20 {
            if rivet_core::pids::process_exe(pid).is_none() {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        if let Some(live) = rivet_core::pids::process_exe(pid) {
            if rivet_core::pids::identity_matches(&live, expected, hints) {
                let _ = Command::new("kill").args(["-KILL", &pid.to_string()]).status();
            }
        }
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

#[cfg(unix)]
unsafe fn libc_setsid() -> i32 {
    extern "C" {
        fn setsid() -> i32;
    }
    setsid()
}
