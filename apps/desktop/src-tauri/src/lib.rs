use std::fs;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use rivet_core::pids::{identity_matches, process_exe, read_pidfile};
use rivet_core::{control_request, control_up, exe_name, sidecar_file_name, RivetPaths};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, RunEvent, WindowEvent,
};

#[derive(Debug)]
struct RivetdState {
    child: Mutex<Option<Child>>,
}

static BOOT_LOCK: Mutex<()> = Mutex::new(());
static STOPPED: AtomicBool = AtomicBool::new(false);

fn rivet_paths() -> Option<RivetPaths> {
    RivetPaths::discover().ok()
}

fn api_up() -> bool {
    let Some(paths) = rivet_paths() else {
        return false;
    };
    control_up(&paths)
}

fn rivet_data_dir() -> Option<PathBuf> {
    Some(dirs::data_dir()?.join("Rivet"))
}

fn rivet_config_path() -> Option<PathBuf> {
    Some(rivet_data_dir()?.join("config.json"))
}

/// Signal only a Rivet-owned PID from a pidfile. Never kill by port/name.
fn signal_owned_pid(pid: u32, expected: Option<&str>, allowed_hints: &[&str]) {
    let Some(live) = process_exe(pid) else {
        return; // already gone
    };
    if !identity_matches(&live, expected, allowed_hints) {
        eprintln!("skipping stale pidfile pid={pid} live={live} expected={expected:?}");
        return;
    }
    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status();
        for _ in 0..20 {
            if process_exe(pid).is_none() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        if let Some(live) = process_exe(pid) {
            if identity_matches(&live, expected, allowed_hints) {
                let _ = Command::new("kill")
                    .args(["-KILL", &pid.to_string()])
                    .status();
            }
        }
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        for _ in 0..20 {
            if process_exe(pid).is_none() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        if let Some(live) = process_exe(pid) {
            if identity_matches(&live, expected, allowed_hints) {
                let _ = Command::new("taskkill")
                    .args(["/PID", &pid.to_string(), "/T", "/F"])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
            }
        }
    }
}

fn rivetd_pid_alive() -> bool {
    let Some(dir) = rivet_data_dir() else {
        return false;
    };
    let path = dir.join("pids").join("rivetd.pid");
    let Some((pid, expected)) = read_pidfile(&path) else {
        return false;
    };
    let Some(live) = process_exe(pid) else {
        return false;
    };
    identity_matches(&live, expected.as_deref(), &["rivetd"])
}

fn read_proxy_access_key() -> Option<String> {
    let path = rivet_config_path()?;
    let raw = fs::read_to_string(path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    v.get("proxy_access_key")
        .and_then(|x| x.as_str())
        .map(str::to_string)
}

fn ask_authenticated_post(path: &str) {
    let Some(paths) = rivet_paths() else {
        return;
    };
    let key = read_proxy_access_key().unwrap_or_default();
    let _ = control_request(&paths, "POST", path, &key, None);
}

fn stop_rivetd(app: &AppHandle) {
    // Tray Quit also triggers RunEvent::Exit — only tear down once.
    if STOPPED.swap(true, Ordering::SeqCst) {
        return;
    }
    // Ask rivetd to stop its own children (clears their pidfiles on success).
    ask_authenticated_post("/v1/shutdown");
    ask_authenticated_post("/v1/proxy/stop");
    std::thread::sleep(std::time::Duration::from_millis(500));

    let child = app
        .try_state::<RivetdState>()
        .and_then(|state| state.child.lock().ok().and_then(|mut slot| slot.take()));
    if let Some(mut child) = child {
        let pid = child.id();
        #[cfg(unix)]
        {
            let _ = Command::new("kill")
                .args(["-TERM", &format!("{pid}")])
                .status();
            for _ in 0..20 {
                match child.try_wait() {
                    Ok(None) => std::thread::sleep(std::time::Duration::from_millis(100)),
                    Ok(Some(_)) | Err(_) => break,
                }
            }
            let _ = child.kill();
            let _ = child.wait();
        }
        #[cfg(windows)]
        {
            let _ = Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    // Only signal PIDs Rivet wrote under the local data dir pids/.
    // Never kill by port (avoids murdering a user's own ClickHouse on 8123).
    let Some(dir) = rivet_data_dir() else {
        return;
    };
    let targets: &[(&str, &[&str])] = &[
        ("rivet-proxy.pid", &["rivet-proxy", "rivet-pro", "cli-proxy", "cliproxy"]),
        ("clickhouse.pid", &["clickhouse", "clickhous"]),
        ("rivetd.pid", &["rivetd"]),
    ];
    for (name, hints) in targets {
        let path = dir.join("pids").join(name);
        if let Some((pid, expected)) = read_pidfile(&path) {
            signal_owned_pid(pid, expected.as_deref(), hints);
            let _ = fs::remove_file(&path);
        }
    }
}

fn spawn_rivetd(app: &AppHandle) -> Result<(), String> {
    let _boot = BOOT_LOCK
        .lock()
        .map_err(|_| "rivetd boot lock poisoned".to_string())?;
    STOPPED.store(false, Ordering::SeqCst);
    if api_up() {
        return Ok(());
    }

    // Held child still alive — wait for the API port instead of forking a twin.
    if let Some(state) = app.try_state::<RivetdState>() {
        let mut slot = state.child.lock().unwrap();
        if let Some(child) = slot.as_mut() {
            match child.try_wait() {
                Ok(None) => {
                    drop(slot);
                    for _ in 0..80 {
                        if api_up() {
                            return Ok(());
                        }
                        std::thread::sleep(std::time::Duration::from_millis(100));
                    }
                    return Ok(());
                }
                Ok(Some(_)) | Err(_) => {
                    *slot = None;
                }
            }
        }
    }

    // Another rivetd is mid-boot (proxy/CH start before control IPC is up).
    if rivetd_pid_alive() {
        for _ in 0..80 {
            if api_up() {
                return Ok(());
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        return Ok(());
    }

    let named = sidecar_file_name("rivetd");
    let plain = exe_name("rivetd");
    let candidates = [
        std::env::var_os("RIVETD_BIN").map(PathBuf::from),
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join(&named))),
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join(&plain))),
        std::env::current_exe().ok().and_then(|p| {
            p.parent()
                .and_then(|d| d.parent())
                .map(|d| d.join(&named))
        }),
        std::env::current_exe().ok().and_then(|p| {
            p.parent()
                .and_then(|d| d.parent())
                .map(|d| d.join(&plain))
        }),
        // Dev: cargo-built binary relative to desktop app cwd / workspace.
        std::env::current_dir()
            .ok()
            .map(|d| d.join("target/debug").join(&plain)),
        std::env::current_dir()
            .ok()
            .map(|d| d.join("../../target/debug").join(&plain)),
        std::env::current_dir()
            .ok()
            .map(|d| d.join("target/release").join(&plain)),
        Some(PathBuf::from(&plain)),
        Some(PathBuf::from("rivetd")),
    ];

    for candidate in candidates.into_iter().flatten() {
        let is_path_lookup = candidate.as_os_str() == "rivetd"
            || candidate.as_os_str() == plain.as_str();
        if is_path_lookup || (candidate.exists() && candidate.is_file()) {
            match Command::new(&candidate)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
            {
                Ok(child) => {
                    if let Some(state) = app.try_state::<RivetdState>() {
                        *state.child.lock().unwrap() = Some(child);
                    }
                    for _ in 0..40 {
                        if api_up() {
                            return Ok(());
                        }
                        std::thread::sleep(std::time::Duration::from_millis(100));
                    }
                    return Ok(());
                }
                Err(err) => {
                    eprintln!(
                        "spawn rivetd via {} failed: {err}",
                        candidate.display()
                    );
                }
            }
        }
    }
    Err("could not start rivetd".into())
}

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn open_wiki_dir(path: &str) -> Result<(), String> {
    reveal_path(path)
}

#[tauri::command]
fn reveal_path(path: &str) -> Result<(), String> {
    let p = PathBuf::from(path);
    if !p.exists() {
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        } else {
            fs::create_dir_all(&p).map_err(|e| e.to_string())?;
        }
    }
    let target = if p.is_file() {
        p.parent().unwrap_or(p.as_path()).to_path_buf()
    } else {
        p
    };
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&target)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(&target)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(&target)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn ensure_rivetd(app: AppHandle) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        spawn_rivetd(&app)?;
        Ok(api_up())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Poll rivetd `/v1/live` and emit `rivet-live` to the webview when the cursor moves.
fn spawn_live_watcher(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last_body = String::new();
        loop {
            std::thread::sleep(std::time::Duration::from_secs(2));
            if STOPPED.load(Ordering::SeqCst) {
                break;
            }
            let Some(paths) = rivet_paths() else {
                continue;
            };
            if !control_up(&paths) {
                continue;
            }
            let key = read_proxy_access_key().unwrap_or_default();
            let Ok(resp) = control_request(&paths, "GET", "/v1/live", &key, None) else {
                continue;
            };
            if resp.status != 200 || resp.body.is_empty() || resp.body == last_body {
                continue;
            }
            last_body = resp.body.clone();
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&resp.body) {
                let _ = app.emit("rivet-live", value);
            }
        }
    });
}

#[derive(serde::Serialize)]
struct ApiIpcResponse {
    status: u16,
    body: String,
    content_type: String,
}

fn validate_api_path(path: &str) -> Result<(), String> {
    let path = path.trim();
    if !path.starts_with("/v1/") {
        return Err("path must start with /v1/".into());
    }
    if path.contains("://") || path.contains('\\') || path.contains("..") {
        return Err("invalid path".into());
    }
    Ok(())
}

/// Proxy a rivetd control-plane request over local IPC (UDS / named pipe).
/// The webview never talks TCP/HTTP and never sees `X-Rivet-Key` — auth is
/// injected from the local config on the host (Docker Desktop–style).
#[tauri::command]
async fn api_request(
    method: String,
    path: String,
    body: Option<String>,
) -> Result<ApiIpcResponse, String> {
    validate_api_path(&path)?;
    let method = method.trim().to_ascii_uppercase();
    match method.as_str() {
        "GET" | "POST" | "PUT" | "PATCH" | "DELETE" => {}
        other => return Err(format!("unsupported method {other}")),
    }

    tauri::async_runtime::spawn_blocking(move || {
        let paths = RivetPaths::discover().map_err(|e| e.to_string())?;
        let key = read_proxy_access_key().unwrap_or_default();
        let resp = control_request(&paths, &method, path.trim(), &key, body.as_deref())
            .map_err(|e| e.to_string())?;
        Ok(ApiIpcResponse {
            status: resp.status,
            body: resp.body,
            content_type: resp.content_type,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(RivetdState {
            child: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            open_wiki_dir,
            reveal_path,
            ensure_rivetd,
            api_request
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            // Don't freeze the UI thread while rivetd boots (proxy/CH can take seconds).
            std::thread::spawn(move || {
                let _ = spawn_rivetd(&handle);
            });
            spawn_live_watcher(app.handle().clone());

            let show_i = MenuItem::with_id(app, "show", "Open Rivet", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit Rivet", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .tooltip("Rivet — local AI proxy")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main(app),
                    "quit" => {
                        stop_rivetd(app);
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;

            if let Some(window) = app.get_webview_window("main") {
                let handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        if let Some(win) = handle.get_webview_window("main") {
                            let _ = win.hide();
                        }
                    }
                });
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Rivet");

    app.run(|app_handle, event| {
        if matches!(event, RunEvent::Exit) {
            stop_rivetd(app_handle);
        }
    });
}
