//! Supervises a bundled single-node ClickHouse sidecar.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use rivet_core::{exe_name, sidecar_file_name, which_bin, RivetConfig, RivetPaths};
use tracing::{info, warn};

pub struct ClickHouseSupervisor {
    paths: RivetPaths,
    config: RivetConfig,
    child: Mutex<Option<Child>>,
}

impl ClickHouseSupervisor {
    pub fn new(paths: RivetPaths, config: RivetConfig) -> Result<Self> {
        write_clickhouse_config(&paths, &config)?;
        Ok(Self {
            paths,
            config,
            child: Mutex::new(None),
        })
    }

    pub fn http_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.config.clickhouse_http_port)
    }

    pub fn resolve_binary() -> Option<PathBuf> {
        if let Ok(explicit) = std::env::var("RIVET_CLICKHOUSE_BIN") {
            let p = PathBuf::from(explicit);
            if p.is_file() {
                return Some(p);
            }
        }

        let named = sidecar_file_name("clickhouse");
        let plain = exe_name("clickhouse");

        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                for candidate in [
                    dir.join(&named),
                    dir.join(&plain),
                    dir.join("clickhouse"),
                    dir.join("binaries").join(&named),
                    dir.join("binaries").join(&plain),
                ] {
                    if candidate.is_file() {
                        return Some(candidate);
                    }
                }
            }
        }

        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        for candidate in [
            manifest
                .join("../../apps/desktop/src-tauri/binaries")
                .join(&named),
            manifest
                .join("../../apps/desktop/src-tauri/binaries")
                .join(&plain),
            PathBuf::from("/tmp/rivet-clickhouse"),
            PathBuf::from("/tmp/rivet-clickhouse.exe"),
        ] {
            if candidate.is_file() {
                return Some(candidate);
            }
        }

        which_bin("clickhouse")
    }

    pub fn is_available() -> bool {
        Self::resolve_binary().is_some()
    }

    pub fn is_running(&self) -> bool {
        let mut slot = self.child.lock().expect("ch child lock");
        self.refresh_locked(&mut slot)
    }

    fn refresh_locked(&self, slot: &mut Option<Child>) -> bool {
        if let Some(child) = slot.as_mut() {
            match child.try_wait() {
                Ok(Some(status)) => {
                    warn!(?status, "clickhouse sidecar exited");
                    *slot = None;
                    crate::pids::clear_clickhouse_pid(&self.paths);
                    false
                }
                Ok(None) => true,
                Err(_) => {
                    *slot = None;
                    crate::pids::clear_clickhouse_pid(&self.paths);
                    false
                }
            }
        } else {
            port_open(self.config.clickhouse_http_port)
        }
    }

    /// Start the sidecar if a binary is present. Returns Ok(false) when skipped.
    pub fn start_if_available(&self) -> Result<bool> {
        let Some(bin) = Self::resolve_binary() else {
            info!("ClickHouse binary not found — set RIVET_CLICKHOUSE_URL or ship the sidecar");
            return Ok(false);
        };

        let mut slot = self.child.lock().expect("ch child lock");
        if self.refresh_locked(&mut slot) {
            info!(
                port = self.config.clickhouse_http_port,
                "clickhouse already listening"
            );
            return Ok(true);
        }

        write_clickhouse_config(&self.paths, &self.config)?;

        let mut cmd = Command::new(&bin);
        cmd.arg("server")
            .arg("--config-file")
            .arg(self.paths.clickhouse_config_file().as_std_path())
            .current_dir(self.paths.clickhouse_dir().as_std_path())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }

        let child = cmd
            .spawn()
            .with_context(|| format!("spawn clickhouse {}", bin.display()))?;
        info!(path = %bin.display(), pid = child.id(), "clickhouse sidecar started");
        crate::pids::write_clickhouse_pid(&self.paths, child.id());
        *slot = Some(child);
        drop(slot);

        let port = self.config.clickhouse_http_port;
        for _ in 0..80 {
            if port_open(port) {
                return Ok(true);
            }
            let mut slot = self.child.lock().expect("ch child lock");
            if !self.refresh_locked(&mut slot) {
                bail!(
                    "clickhouse exited before listening on 127.0.0.1:{port} — check {}",
                    self.paths.clickhouse_log_dir()
                );
            }
            thread::sleep(Duration::from_millis(150));
        }
        // Still starting; callers can retry readiness.
        Ok(true)
    }

    pub fn stop(&self) -> Result<()> {
        let mut slot = self.child.lock().expect("ch child lock");
        if let Some(mut child) = slot.take() {
            let pid = child.id();
            #[cfg(unix)]
            {
                let _ = Command::new("kill")
                    .args(["-TERM", &format!("-{pid}")])
                    .status();
                thread::sleep(Duration::from_millis(200));
                let _ = Command::new("kill")
                    .args(["-KILL", &format!("-{pid}")])
                    .status();
            }
            #[cfg(windows)]
            {
                let _ = Command::new("taskkill")
                    .args(["/PID", &pid.to_string(), "/T", "/F"])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
            }
            let _ = child.kill();
            let _ = child.wait();
            info!(pid, "clickhouse sidecar stopped");
            crate::pids::clear_clickhouse_pid_if_ours(&self.paths, pid);
        }
        Ok(())
    }
}

impl Drop for ClickHouseSupervisor {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

pub fn write_clickhouse_config(paths: &RivetPaths, config: &RivetConfig) -> Result<()> {
    paths.ensure()?;
    let xml = format!(
        r#"<?xml version="1.0"?>
<!-- Generated by Rivet — local single-node analytics sidecar -->
<clickhouse>
    <logger>
        <level>warning</level>
        <console>false</console>
        <log>{log_dir}/clickhouse.log</log>
        <errorlog>{log_dir}/clickhouse.err.log</errorlog>
        <size>50M</size>
        <count>3</count>
    </logger>

    <http_port>{http_port}</http_port>
    <tcp_port>{tcp_port}</tcp_port>
    <listen_host>127.0.0.1</listen_host>

    <path>{data}/</path>
    <tmp_path>{tmp}/</tmp_path>
    <user_files_path>{user_files}/</user_files_path>
    <format_schema_path>{user_files}/</format_schema_path>

    <mlock_executable>false</mlock_executable>
    <max_server_memory_usage_to_ram_ratio>0.5</max_server_memory_usage_to_ram_ratio>

    <users>
        <default>
            <password></password>
            <networks>
                <ip>::1</ip>
                <ip>127.0.0.1</ip>
            </networks>
            <profile>default</profile>
            <quota>default</quota>
            <access_management>1</access_management>
        </default>
    </users>
    <profiles>
        <default>
            <max_memory_usage>4000000000</max_memory_usage>
        </default>
    </profiles>
    <quotas>
        <default>
            <interval>
                <duration>3600</duration>
                <queries>0</queries>
                <errors>0</errors>
                <result_rows>0</result_rows>
                <read_rows>0</read_rows>
                <execution_time>0</execution_time>
            </interval>
        </default>
    </quotas>
</clickhouse>
"#,
        log_dir = paths.clickhouse_log_dir(),
        http_port = config.clickhouse_http_port,
        tcp_port = config.clickhouse_native_port,
        data = paths.clickhouse_data_dir(),
        tmp = paths.clickhouse_tmp_dir(),
        user_files = paths.clickhouse_user_files_dir(),
    );
    std::fs::write(paths.clickhouse_config_file().as_std_path(), xml)?;
    Ok(())
}

fn port_open(port: u16) -> bool {
    std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_millis(80),
    )
    .is_ok()
}

#[allow(dead_code)]
fn _path_is_bin(p: &Path) -> bool {
    p.is_file()
}
