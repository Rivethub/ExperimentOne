//! Supervises the `rivet-proxy` (`CLIProxyAPI`) sidecar and account login flows.

use std::fmt::Write as _;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use rivet_api::{
    AccountInfo, ControlApi, HarnessWriteResponse, LoginStartResponse, LoginStatusResponse,
};
use rivet_core::{
    exe_name, install_harness, sidecar_file_name, which_bin, write_proxy_config,
    HarnessInstallMode, RivetConfig, RivetPaths,
};
use tracing::{info, warn};

#[derive(Debug)]
pub struct ProxySupervisor {
    paths: RivetPaths,
    config: RivetConfig,
    child: Mutex<Option<Child>>,
    running: Mutex<bool>,
    /// User/boot wants the proxy up — watchdog restarts if the child dies.
    want_running: Mutex<bool>,
    login: Mutex<Option<LoginSession>>,
}

#[derive(Debug)]
struct LoginSession {
    provider: String,
    child: Child,
    output: Arc<Mutex<String>>,
    done: Arc<Mutex<bool>>,
    success: Arc<Mutex<bool>>,
}

impl ProxySupervisor {
    pub fn new(paths: RivetPaths, config: RivetConfig) -> Result<Self> {
        write_proxy_config(&config, &paths)?;
        Ok(Self {
            paths,
            config,
            child: Mutex::new(None),
            running: Mutex::new(false),
            want_running: Mutex::new(false),
            login: Mutex::new(None),
        })
    }

    pub fn want_running(&self) -> bool {
        *self.want_running.lock().expect("want_running lock")
    }

    /// If the proxy was supposed to stay up but exited, start it again.
    pub fn ensure_desired(&self) -> Result<bool> {
        if !self.want_running() {
            return Ok(false);
        }
        if self.is_running() {
            return Ok(false);
        }
        warn!("proxy sidecar missing while desired — restarting");
        self.start()?;
        Ok(true)
    }

    pub const fn config(&self) -> &RivetConfig {
        &self.config
    }

    fn resolve_binary() -> Result<PathBuf> {
        if let Ok(explicit) = std::env::var("RIVET_PROXY_BIN") {
            let p = PathBuf::from(explicit);
            if p.is_file() {
                return Ok(p);
            }
            bail!("RIVET_PROXY_BIN set but not a file: {}", p.display());
        }

        let named = sidecar_file_name("rivet-proxy");
        let plain = exe_name("rivet-proxy");

        // Next to the running binary (Tauri bundle / sidecar layout).
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                for candidate in [
                    dir.join(&named),
                    dir.join(&plain),
                    dir.join("rivet-proxy"),
                    dir.join("binaries").join(&named),
                    dir.join("binaries").join(&plain),
                ] {
                    if candidate.is_file() {
                        return Ok(candidate);
                    }
                }
            }
        }

        // Dev tree: apps/desktop/src-tauri/binaries/
        let manifest_candidates = [
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../apps/desktop/src-tauri/binaries")
                .join(&named),
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../apps/desktop/src-tauri/binaries")
                .join(&plain),
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../apps/desktop/src-tauri/binaries/rivet-proxy"),
            PathBuf::from("/tmp/rivet-proxy"),
            PathBuf::from("/tmp/rivet-proxy.exe"),
        ];
        for candidate in manifest_candidates {
            if candidate.is_file() {
                return Ok(candidate);
            }
        }

        for name in ["rivet-proxy", "cli-proxy-api"] {
            if let Some(p) = which_bin(name) {
                return Ok(p);
            }
        }

        bail!(
            "rivet-proxy binary not found — build with scripts/build-sidecars.sh \
             (or set RIVET_PROXY_BIN)"
        )
    }

    fn base_command(&self, bin: &Path) -> Result<Command> {
        write_proxy_config(&self.config, &self.paths)?;
        let mut cmd = Command::new(bin);
        cmd.current_dir(self.paths.proxy_dir().as_std_path())
            .arg("-config")
            .arg(self.paths.proxy_config_file().as_std_path())
            .env(
                "RIVET_INGEST_URL",
                format!("http://127.0.0.1:{}", self.config.api_port),
            )
            .env("RIVET_INGEST_KEY", &self.config.proxy_access_key);
        Ok(cmd)
    }

    #[allow(clippy::option_if_let_else)] // Clearing `child_slot` requires a mutable borrow alongside `try_wait`.
    fn refresh_running_locked(&self, child_slot: &mut Option<Child>) -> bool {
        if let Some(child) = child_slot.as_mut() {
            match child.try_wait() {
                Ok(Some(status)) => {
                    warn!(?status, "proxy sidecar exited");
                    *child_slot = None;
                    crate::pids::clear_proxy_pid(&self.paths);
                    false
                }
                Ok(None) => true,
                Err(err) => {
                    warn!(?err, "proxy status check failed");
                    *child_slot = None;
                    crate::pids::clear_proxy_pid(&self.paths);
                    false
                }
            }
        } else {
            false
        }
    }

    pub fn start(&self) -> Result<()> {
        let already_running = {
            let mut child_slot = self.child.lock().expect("proxy child lock");
            if self.refresh_running_locked(&mut child_slot) {
                *self.running.lock().expect("running lock") = true;
                true
            } else {
                false
            }
        };
        if already_running {
            return Ok(());
        }

        // Drop orphans left by a previous rivetd so we don't bind the wrong port
        // or leave an ingest-deaf proxy running after a crash.
        crate::pids::reclaim_proxy_orphan(&self.paths);

        let bin = Self::resolve_binary()?;
        let mut cmd = self.base_command(&bin)?;
        cmd.stdout(Stdio::null()).stderr(Stdio::null());
        // Own process group so sidecar lifecycle stays isolated from rivetd.
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }

        let child = cmd
            .spawn()
            .with_context(|| format!("spawn proxy {}", bin.display()))?;
        info!(path = %bin.display(), pid = child.id(), "proxy sidecar started");
        crate::pids::write_proxy_pid(&self.paths, child.id());
        {
            let mut child_slot = self.child.lock().expect("proxy child lock");
            *child_slot = Some(child);
        }
        *self.running.lock().expect("running lock") = true;
        *self.want_running.lock().expect("want_running lock") = true;

        // Brief readiness wait; fail if the child exits before the port opens
        // (common when the configured proxy port is already bound).
        let port = self.config.proxy_port;
        for _ in 0..30 {
            if port_open(port) {
                return Ok(());
            }
            let died = {
                let mut child_slot = self.child.lock().expect("proxy child lock");
                !self.refresh_running_locked(&mut child_slot)
            };
            if died {
                *self.running.lock().expect("running lock") = false;
                bail!(
                    "proxy exited before listening on 127.0.0.1:{port} — \
                     is the port free? (change proxy_port in Rivet config.json)"
                );
            }
            thread::sleep(Duration::from_millis(100));
        }
        Ok(())
    }

    pub fn stop(&self) -> Result<()> {
        let child = {
            let mut child_slot = self.child.lock().expect("proxy child lock");
            child_slot.take()
        };
        if let Some(mut child) = child {
            let pid = child.id();
            info!(pid, "stopping proxy sidecar");
            // Sidecar was started in its own process group — signal the group first.
            #[cfg(unix)]
            {
                let _ = Command::new("kill")
                    .args(["-TERM", &format!("-{pid}")])
                    .status();
                thread::sleep(Duration::from_millis(150));
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
            if let Err(err) = child.kill() {
                warn!(pid, ?err, "proxy kill failed");
            }
            match child.wait() {
                Ok(status) => info!(pid, ?status, "proxy sidecar stopped"),
                Err(err) => warn!(pid, ?err, "proxy wait failed"),
            }
            crate::pids::clear_proxy_pid_if_ours(&self.paths, pid);
        } else {
            info!("proxy stop requested but no child handle — reclaiming pidfile orphan");
            crate::pids::reclaim_proxy_orphan(&self.paths);
        }
        *self.running.lock().expect("running lock") = false;
        *self.want_running.lock().expect("want_running lock") = false;
        Ok(())
    }

    pub fn is_running(&self) -> bool {
        let alive = {
            let mut child_slot = self.child.lock().expect("proxy child lock");
            self.refresh_running_locked(&mut child_slot)
        };
        *self.running.lock().expect("running lock") = alive;
        alive
    }

    pub fn start_login(&self, provider: &str, method: Option<&str>) -> Result<LoginStartResponse> {
        let entry = rivet_core::find_provider(provider).ok_or_else(|| {
            anyhow::anyhow!(
                "unsupported provider '{provider}' — see GET /v1/providers for the prox catalog"
            )
        })?;
        let flag = rivet_core::login_flag_for_method(provider, method).ok_or_else(|| {
            if entry.login_flag.is_none() {
                anyhow::anyhow!(
                    "provider '{}' uses file import, not OAuth login — use POST /v1/accounts/import/vertex",
                    entry.id
                )
            } else {
                anyhow::anyhow!(
                    "unsupported login method {:?} for provider '{}'",
                    method,
                    entry.id
                )
            }
        })?;
        let provider = entry.id.clone();
        let hint = match (provider.as_str(), flag) {
            ("codex", "codex-device-login") => Some(
                "Device code — enable Codex device sign-in under ChatGPT Security Settings if prompted, then enter the code."
                    .into(),
            ),
            _ => Some(entry.hint.clone()),
        };

        {
            let mut login = self.login.lock().expect("login lock");
            if let Some(session) = login.as_mut() {
                if session.child.try_wait().ok().flatten().is_none() {
                    bail!("a login flow is already running ({})", session.provider);
                }
            }
            *login = None;
        }

        let bin = Self::resolve_binary()?;
        let mut cmd = self.base_command(&bin)?;
        cmd.arg(format!("-{flag}"))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }

        let mut child = cmd
            .spawn()
            .with_context(|| format!("spawn login {}", bin.display()))?;

        let output = Arc::new(Mutex::new(String::new()));
        let done = Arc::new(Mutex::new(false));
        let success = Arc::new(Mutex::new(false));

        if let Some(stdout) = child.stdout.take() {
            spawn_reader(stdout, output.clone());
        }
        if let Some(stderr) = child.stderr.take() {
            spawn_reader(stderr, output.clone());
        }

        let mode = if flag.contains("device") {
            "device"
        } else {
            "browser"
        };
        append_login_log(&output, &format!("Starting {} {mode} login…", entry.label));
        if let Some(h) = hint.as_deref() {
            append_login_log(&output, h);
        }

        *self.login.lock().expect("login lock") = Some(LoginSession {
            provider: provider.clone(),
            child,
            output,
            done,
            success,
        });

        Ok(LoginStartResponse {
            provider,
            message: "Login process started — watch the live log.".into(),
            hint,
        })
    }

    /// Import a Vertex service-account JSON via the proxy CLI (`-vertex-import`).
    pub fn import_vertex(&self, path: &str) -> Result<LoginStartResponse> {
        let path = path.trim();
        if path.is_empty() {
            bail!("path is required");
        }
        let p = Path::new(path);
        if !p.is_file() {
            bail!("vertex key file not found: {path}");
        }

        {
            let mut login = self.login.lock().expect("login lock");
            if let Some(session) = login.as_mut() {
                if session.child.try_wait().ok().flatten().is_none() {
                    bail!("a login flow is already running ({})", session.provider);
                }
            }
            *login = None;
        }

        let bin = Self::resolve_binary()?;
        let mut cmd = self.base_command(&bin)?;
        cmd.arg("-vertex-import")
            .arg(path)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }

        let mut child = cmd
            .spawn()
            .with_context(|| format!("spawn vertex import {}", bin.display()))?;
        let output = Arc::new(Mutex::new(String::new()));
        let done = Arc::new(Mutex::new(false));
        let success = Arc::new(Mutex::new(false));
        if let Some(stdout) = child.stdout.take() {
            spawn_reader(stdout, output.clone());
        }
        if let Some(stderr) = child.stderr.take() {
            spawn_reader(stderr, output.clone());
        }
        append_login_log(&output, &format!("Importing Vertex service account from {path}…"));
        let login_session = LoginSession {
            provider: "vertex".into(),
            child,
            output,
            done,
            success,
        };
        *self.login.lock().expect("login lock") = Some(login_session);

        Ok(LoginStartResponse {
            provider: "vertex".into(),
            message: "Vertex import started — watch the live log.".into(),
            hint: Some(
                "Service-account JSON is copied into the proxy auth dir; never exported.".into(),
            ),
        })
    }

    pub fn login_status(&self) -> LoginStatusResponse {
        let mut login_guard = self.login.lock().expect("login lock");
        let Some(session) = login_guard.as_mut() else {
            return LoginStatusResponse {
                active: false,
                provider: None,
                output: String::new(),
                done: true,
                success: false,
            };
        };

        if let Ok(Some(status)) = session.child.try_wait() {
            *session.done.lock().expect("done") = true;
            *session.success.lock().expect("success") = status.success();
            if status.success() {
                let mut buf = session.output.lock().expect("output");
                if !buf.contains("successful") {
                    buf.push_str("\nLogin finished successfully.\n");
                }
            }
        }

        let done = *session.done.lock().expect("done");
        let success = *session.success.lock().expect("success");
        let output = session.output.lock().expect("output").clone();
        let provider = session.provider.clone();
        drop(login_guard);
        LoginStatusResponse {
            active: !done,
            provider: Some(provider),
            output,
            done,
            success,
        }
    }

    pub fn cancel_login(&self) -> Result<()> {
        let session = {
            let mut login = self.login.lock().expect("login lock");
            login.take()
        };
        if let Some(mut session) = session {
            let _ = session.child.kill();
            let _ = session.child.wait();
            *session.done.lock().expect("done") = true;
        }
        Ok(())
    }

    pub fn list_accounts(&self) -> Result<Vec<AccountInfo>> {
        let dir = self.paths.proxy_auth_dir();
        let mut out = Vec::new();
        let Ok(entries) = std::fs::read_dir(dir.as_std_path()) else {
            return Ok(out);
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let id = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("unknown")
                .to_string();
            let raw = std::fs::read_to_string(&path).unwrap_or_default();
            let meta: serde_json::Value =
                serde_json::from_str(&raw).unwrap_or_else(|_| serde_json::json!({}));
            let provider = rivet_core::normalize_provider_id(
                meta.get("type")
                    .or_else(|| meta.get("provider"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("other"),
            );
            let label = meta
                .get("email")
                .or_else(|| meta.get("label"))
                .or_else(|| meta.get("name"))
                .and_then(|v| v.as_str())
                .unwrap_or(&id)
                .to_string();
            out.push(AccountInfo {
                id,
                provider,
                label,
                limit_hint: "—".into(),
                reset_hint: "—".into(),
            });
        }
        out.sort_by(|a, b| a.provider.cmp(&b.provider).then(a.label.cmp(&b.label)));
        Ok(out)
    }

    pub fn remove_account(&self, id: &str) -> Result<()> {
        let id = id.trim();
        if id.is_empty()
            || id.contains('/')
            || id.contains('\\')
            || id.contains("..")
            || id.contains('\0')
        {
            bail!("invalid account id");
        }
        let path = self.paths.proxy_auth_dir().join(format!("{id}.json"));
        if !path.exists() {
            bail!("account not found: {id}");
        }
        std::fs::remove_file(path.as_std_path())
            .with_context(|| format!("remove account file {path}"))?;
        info!(%id, "removed provider account credential");
        Ok(())
    }

    pub fn write_harness(&self, target: &str, mode: Option<&str>) -> Result<HarnessWriteResponse> {
        self.paths.ensure()?;
        let mode = HarnessInstallMode::parse(mode);
        let result = install_harness(
            target,
            mode,
            &self.config,
            self.paths.harness_claude_dir().as_std_path(),
            self.paths.harness_codex_dir().as_std_path(),
        )?;
        Ok(HarnessWriteResponse {
            target: result.target,
            path: result.path,
            env_hint: result.env_hint,
            note: result.note,
            backup_path: result.backup_path,
            mode: match mode {
                HarnessInstallMode::User => "user".into(),
                HarnessInstallMode::Isolated => "isolated".into(),
            },
        })
    }
}

impl ControlApi for ProxySupervisor {
    fn proxy_running(&self) -> bool {
        self.is_running()
    }

    fn proxy_start(&self) -> Result<(), String> {
        self.start().map_err(|e| e.to_string())
    }

    fn proxy_stop(&self) -> Result<(), String> {
        self.stop().map_err(|e| e.to_string())
    }

    fn login_start(
        &self,
        provider: &str,
        method: Option<&str>,
    ) -> Result<LoginStartResponse, String> {
        self.start_login(provider, method)
            .map_err(|e| e.to_string())
    }

    fn import_vertex(&self, path: &str) -> Result<LoginStartResponse, String> {
        Self::import_vertex(self, path).map_err(|e| e.to_string())
    }

    fn login_status(&self) -> LoginStatusResponse {
        Self::login_status(self)
    }

    fn login_cancel(&self) -> Result<(), String> {
        self.cancel_login().map_err(|e| e.to_string())
    }

    fn list_accounts(&self) -> Result<Vec<AccountInfo>, String> {
        Self::list_accounts(self).map_err(|e| e.to_string())
    }

    fn remove_account(&self, id: &str) -> Result<(), String> {
        Self::remove_account(self, id).map_err(|e| e.to_string())
    }

    fn write_harness(
        &self,
        target: &str,
        mode: Option<&str>,
    ) -> Result<HarnessWriteResponse, String> {
        Self::write_harness(self, target, mode).map_err(|e| e.to_string())
    }
}

impl Drop for ProxySupervisor {
    fn drop(&mut self) {
        let _ = self.cancel_login();
        let _ = self.stop();
    }
}

const LOGIN_LOG_CAP_BYTES: usize = 64 * 1024;

#[allow(clippy::significant_drop_tightening)] // Guard must cover the write to the shared login log.
fn append_login_log(output: &Arc<Mutex<String>>, line: &str) {
    let mut buf = output.lock().expect("output lock");
    let _ = writeln!(buf, "{line}");
    drop(buf);
}

fn spawn_reader(mut pipe: impl Read + Send + 'static, output: Arc<Mutex<String>>) {
    thread::spawn(move || {
        let mut buf = [0u8; 1024];
        loop {
            match pipe.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&buf[..n]);
                    if let Ok(mut out) = output.lock() {
                        out.push_str(&chunk);
                        // Cap log size so a runaway process can't blow memory.
                        if out.len() > LOGIN_LOG_CAP_BYTES {
                            let trim = out.len() - LOGIN_LOG_CAP_BYTES;
                            out.drain(..trim);
                        }
                    }
                }
            }
        }
    });
}

fn port_open(port: u16) -> bool {
    std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_millis(50),
    )
    .is_ok()
}
