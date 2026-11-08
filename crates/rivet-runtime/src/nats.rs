//! Supervises a bundled single-node NATS `JetStream` sidecar (job plane).

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use rivet_core::{exe_name, sidecar_file_name, which_bin, RivetConfig, RivetPaths};
use tracing::{info, warn};

#[derive(Debug)]
pub struct NatsSupervisor {
    paths: RivetPaths,
    config: RivetConfig,
    child: Mutex<Option<Child>>,
}

impl NatsSupervisor {
    pub fn new(paths: RivetPaths, config: RivetConfig) -> Result<Self> {
        write_nats_config(&paths, &config)?;
        Ok(Self { paths, config, child: Mutex::new(None) })
    }

    pub fn client_url(&self) -> String {
        format!("nats://127.0.0.1:{}", self.config.nats_port)
    }

    pub fn resolve_binary() -> Option<PathBuf> {
        if let Ok(explicit) = std::env::var("RIVET_NATS_BIN") {
            let p = PathBuf::from(explicit);
            if p.is_file() {
                return Some(p);
            }
        }

        let named = sidecar_file_name("nats-server");
        let plain = exe_name("nats-server");

        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                for candidate in [
                    dir.join(&named),
                    dir.join(&plain),
                    dir.join("nats-server"),
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
            manifest.join("../../apps/desktop/src-tauri/binaries").join(&named),
            manifest.join("../../apps/desktop/src-tauri/binaries").join(&plain),
            PathBuf::from("/tmp/rivet-nats-server"),
            PathBuf::from("/tmp/rivet-nats-server.exe"),
        ] {
            if candidate.is_file() {
                return Some(candidate);
            }
        }

        which_bin("nats-server")
    }

    pub fn is_available() -> bool {
        Self::resolve_binary().is_some()
    }

    pub fn is_running(&self) -> bool {
        let mut slot = self.child.lock().expect("nats child lock");
        self.refresh_locked(&mut slot)
    }

    #[allow(clippy::option_if_let_else)]
    fn refresh_locked(&self, slot: &mut Option<Child>) -> bool {
        if let Some(child) = slot.as_mut() {
            match child.try_wait() {
                Ok(Some(status)) => {
                    warn!(?status, "nats sidecar exited");
                    *slot = None;
                    crate::pids::clear_nats_pid(&self.paths);
                    false
                },
                Ok(None) => true,
                Err(_) => {
                    *slot = None;
                    crate::pids::clear_nats_pid(&self.paths);
                    false
                },
            }
        } else {
            port_open(self.config.nats_port)
        }
    }

    /// Start the sidecar if a binary is present. Returns Ok(false) when skipped.
    pub fn start_if_available(&self) -> Result<bool> {
        let Some(bin) = Self::resolve_binary() else {
            info!("NATS binary not found — set RIVET_NATS_URL or ship the nats-server sidecar");
            return Ok(false);
        };

        let mut slot = self.child.lock().expect("nats child lock");
        if self.refresh_locked(&mut slot) {
            info!(port = self.config.nats_port, "nats already listening");
            return Ok(true);
        }

        write_nats_config(&self.paths, &self.config)?;

        let mut cmd = Command::new(&bin);
        cmd.arg("-c")
            .arg(self.paths.nats_config_file().as_std_path())
            .current_dir(self.paths.nats_dir().as_std_path())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }

        let child = cmd.spawn().with_context(|| format!("spawn nats-server {}", bin.display()))?;
        info!(path = %bin.display(), pid = child.id(), "nats sidecar started");
        crate::pids::write_nats_pid(&self.paths, child.id());
        *slot = Some(child);
        drop(slot);

        let port = self.config.nats_port;
        for _ in 0..80 {
            if port_open(port) {
                return Ok(true);
            }
            let exited = {
                let mut slot = self.child.lock().expect("nats child lock");
                !self.refresh_locked(&mut slot)
            };
            if exited {
                bail!(
                    "nats-server exited before listening on 127.0.0.1:{port} — check {}",
                    self.paths.nats_log_dir()
                );
            }
            thread::sleep(Duration::from_millis(150));
        }
        Ok(true)
    }

    pub fn stop(&self) -> Result<()> {
        let child = {
            let mut slot = self.child.lock().expect("nats child lock");
            slot.take()
        };
        if let Some(mut child) = child {
            let pid = child.id();
            #[cfg(unix)]
            {
                let _ = Command::new("kill").args(["-TERM", &format!("-{pid}")]).status();
                thread::sleep(Duration::from_millis(200));
                let _ = Command::new("kill").args(["-KILL", &format!("-{pid}")]).status();
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
            crate::pids::clear_nats_pid(&self.paths);
        } else if let Some(pid) = read_pid_file(self.paths.nats_pid_file().as_std_path()) {
            crate::pids::clear_nats_pid_if_ours(&self.paths, pid);
        }
        Ok(())
    }
}

fn write_nats_config(paths: &RivetPaths, config: &RivetConfig) -> Result<()> {
    paths.ensure()?;
    let store = paths.nats_store_dir();
    let log = paths.nats_log_dir().join("nats.log");
    // Sync interval 2s (not the multi-minute default) so ack ≈ durable for local power loss.
    let conf = format!(
        r#"
port: {port}
net: "127.0.0.1"
http: "127.0.0.1:{http_port}"
server_name: rivet-local
debug: false
trace: false
log_file: "{log}"
max_payload: 8MB

jetstream {{
  store_dir: "{store}"
  max_mem: 256MB
  max_file: 4GB
  sync_interval: 2s
}}
"#,
        port = config.nats_port,
        http_port = config.nats_port.saturating_add(1000),
        log = log.as_str().replace('\\', "\\\\"),
        store = store.as_str().replace('\\', "\\\\"),
    );
    std::fs::write(paths.nats_config_file().as_std_path(), conf.trim_start())?;
    Ok(())
}

fn port_open(port: u16) -> bool {
    std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_millis(50),
    )
    .is_ok()
}

fn read_pid_file(path: &Path) -> Option<u32> {
    let raw = std::fs::read_to_string(path).ok()?;
    raw.trim().parse().ok()
}
