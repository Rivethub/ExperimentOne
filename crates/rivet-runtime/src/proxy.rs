//! Supervises the `rivet-proxy` (CLIProxyAPI) sidecar and account login flows.

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
    claude_settings_json, codex_config_toml, write_proxy_config, RivetConfig, RivetPaths,
};
use tracing::{info, warn};

pub struct ProxySupervisor {
    paths: RivetPaths,
    config: RivetConfig,
    child: Mutex<Option<Child>>,
    running: Mutex<bool>,
    login: Mutex<Option<LoginSession>>,
}

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
            login: Mutex::new(None),
        })
    }

    pub fn config(&self) -> &RivetConfig {
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

        let triple = target_triple();
        let named = format!("rivet-proxy-{triple}");

        // Next to the running binary (Tauri bundle / sidecar layout).
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                for candidate in [
                    dir.join(&named),
                    dir.join("rivet-proxy"),
                    dir.join("binaries").join(&named),
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
                .join("../../apps/desktop/src-tauri/binaries/rivet-proxy"),
            PathBuf::from("/tmp/rivet-proxy"),
        ];
        for candidate in manifest_candidates {
            if candidate.is_file() {
                return Ok(candidate);
            }
        }

        for name in ["rivet-proxy", "cli-proxy-api"] {
            if let Some(p) = which(name) {
                return Ok(p);
            }
        }

        bail!(
            "rivet-proxy binary not found — build with: cd vendor/cliproxyapi && \
             PATH=\"/usr/local/go/bin:$PATH\" go build -o /tmp/rivet-proxy ./cmd/server \
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
            );
        Ok(cmd)
    }

    fn refresh_running_locked(&self, child_slot: &mut Option<Child>) -> bool {
        if let Some(child) = child_slot.as_mut() {
            match child.try_wait() {
                Ok(Some(status)) => {
                    warn!(?status, "proxy sidecar exited");
                    *child_slot = None;
                    false
                }
                Ok(None) => true,
                Err(err) => {
                    warn!(?err, "proxy status check failed");
                    *child_slot = None;
                    false
                }
            }
        } else {
            false
        }
    }

    pub fn start(&self) -> Result<()> {
        let mut child_slot = self.child.lock().expect("proxy child lock");
        if self.refresh_running_locked(&mut child_slot) {
            *self.running.lock().expect("running lock") = true;
            return Ok(());
        }

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
        *child_slot = Some(child);
        *self.running.lock().expect("running lock") = true;

        // Brief readiness wait; fail if the child exits before the port opens
        // (common when the configured proxy port is already bound).
        let port = self.config.proxy_port;
        for _ in 0..30 {
            if port_open(port) {
                return Ok(());
            }
            if !self.refresh_running_locked(&mut child_slot) {
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
        let mut child_slot = self.child.lock().expect("proxy child lock");
        if let Some(mut child) = child_slot.take() {
            let pid = child.id();
            info!(pid, "stopping proxy sidecar");
            if let Err(err) = child.kill() {
                warn!(pid, ?err, "proxy kill failed");
            }
            match child.wait() {
                Ok(status) => info!(pid, ?status, "proxy sidecar stopped"),
                Err(err) => warn!(pid, ?err, "proxy wait failed"),
            }
        } else {
            info!("proxy stop requested but no child handle");
        }
        *self.running.lock().expect("running lock") = false;
        Ok(())
    }

    pub fn is_running(&self) -> bool {
        let mut child_slot = self.child.lock().expect("proxy child lock");
        let alive = self.refresh_running_locked(&mut child_slot);
        *self.running.lock().expect("running lock") = alive;
        alive
    }

    pub fn start_login(&self, provider: &str) -> Result<LoginStartResponse> {
        let provider = provider.to_ascii_lowercase();
        let flag = match provider.as_str() {
            "claude" => "-claude-login",
            "codex" => "-codex-device-login",
            other => bail!("unsupported provider '{other}' (use claude or codex)"),
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
        cmd.arg(flag)
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

        {
            let mut buf = output.lock().expect("output lock");
            match provider.as_str() {
                "claude" => buf.push_str(
                    "Starting Claude OAuth login…\nA browser window should open. If not, copy the URL from the log below.\n",
                ),
                "codex" => buf.push_str(
                    "Starting Codex device login…\nWatch for the device URL and code below.\n",
                ),
                _ => {}
            }
        }

        let hint = match provider.as_str() {
            "claude" => Some(
                "Complete sign-in in the browser. Headless/SSH: use SSH tunnel docs for the OAuth callback port."
                    .into(),
            ),
            "codex" => Some(
                "Open https://auth.openai.com/codex/device and enter the device code shown in the log."
                    .into(),
            ),
            _ => None,
        };

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

    pub fn login_status(&self) -> LoginStatusResponse {
        let mut login = self.login.lock().expect("login lock");
        let Some(session) = login.as_mut() else {
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
        LoginStatusResponse {
            active: !done,
            provider: Some(session.provider.clone()),
            output,
            done,
            success,
        }
    }

    pub fn cancel_login(&self) -> Result<()> {
        let mut login = self.login.lock().expect("login lock");
        if let Some(mut session) = login.take() {
            let _ = session.child.kill();
            let _ = session.child.wait();
            *session.done.lock().expect("done") = true;
        }
        Ok(())
    }

    pub fn list_accounts(&self) -> Result<Vec<AccountInfo>> {
        let dir = self.paths.proxy_auth_dir();
        let mut out = Vec::new();
        let entries = match std::fs::read_dir(dir.as_std_path()) {
            Ok(e) => e,
            Err(_) => return Ok(out),
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
                serde_json::from_str(&raw).unwrap_or(serde_json::json!({}));
            let provider = meta
                .get("type")
                .or_else(|| meta.get("provider"))
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .to_string();
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
            .with_context(|| format!("remove account file {}", path))?;
        info!(%id, "removed provider account credential");
        Ok(())
    }

    pub fn write_harness(&self, target: &str) -> Result<HarnessWriteResponse> {
        self.paths.ensure()?;
        match target {
            "claude" => {
                let dir = self.paths.harness_claude_dir();
                let path = dir.join("settings.json");
                std::fs::write(path.as_std_path(), claude_settings_json(&self.config))?;
                Ok(HarnessWriteResponse {
                    target: "claude".into(),
                    path: path.to_string(),
                    env_hint: format!("CLAUDE_CONFIG_DIR={}", dir.as_str()),
                    note: "Default Claude installs are untouched. Export CLAUDE_CONFIG_DIR before launching Claude Code.".into(),
                })
            }
            "codex" => {
                let dir = self.paths.harness_codex_dir();
                let path = dir.join("config.toml");
                std::fs::write(path.as_std_path(), codex_config_toml(&self.config))?;
                Ok(HarnessWriteResponse {
                    target: "codex".into(),
                    path: path.to_string(),
                    env_hint: format!("CODEX_HOME={}", dir.as_str()),
                    note: "Default Codex installs are untouched. Export CODEX_HOME before launching Codex.".into(),
                })
            }
            other => bail!("unknown harness target '{other}'"),
        }
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

    fn login_start(&self, provider: &str) -> Result<LoginStartResponse, String> {
        self.start_login(provider).map_err(|e| e.to_string())
    }

    fn login_status(&self) -> LoginStatusResponse {
        ProxySupervisor::login_status(self)
    }

    fn login_cancel(&self) -> Result<(), String> {
        self.cancel_login().map_err(|e| e.to_string())
    }

    fn list_accounts(&self) -> Result<Vec<AccountInfo>, String> {
        ProxySupervisor::list_accounts(self).map_err(|e| e.to_string())
    }

    fn remove_account(&self, id: &str) -> Result<(), String> {
        ProxySupervisor::remove_account(self, id).map_err(|e| e.to_string())
    }

    fn write_harness(&self, target: &str) -> Result<HarnessWriteResponse, String> {
        ProxySupervisor::write_harness(self, target).map_err(|e| e.to_string())
    }
}

impl Drop for ProxySupervisor {
    fn drop(&mut self) {
        let _ = self.cancel_login();
        let _ = self.stop();
    }
}

fn spawn_reader(mut pipe: impl Read + Send + 'static, output: Arc<Mutex<String>>) {
    thread::spawn(move || {
        let mut buf = [0u8; 1024];
        loop {
            match pipe.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&buf[..n]);
                    if let Ok(mut out) = output.lock() {
                        out.push_str(&chunk);
                        // Cap log size so a runaway process can't blow memory.
                        const MAX: usize = 64 * 1024;
                        if out.len() > MAX {
                            let trim = out.len() - MAX;
                            out.drain(..trim);
                        }
                    }
                }
                Err(_) => break,
            }
        }
    });
}

fn which(bin: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|paths| {
        for dir in std::env::split_paths(&paths) {
            let p = dir.join(bin);
            if p.is_file() {
                return Some(p);
            }
        }
        None
    })
}

fn target_triple() -> &'static str {
    // Prefer compile-time target for matching Tauri externalBin names.
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
    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "aarch64"),
    )))]
    {
        "unknown"
    }
}

fn port_open(port: u16) -> bool {
    std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_millis(50),
    )
    .is_ok()
}
