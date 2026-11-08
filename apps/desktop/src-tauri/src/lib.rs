use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, RunEvent, WindowEvent,
};
use tauri_plugin_shell::ShellExt;

struct RivetdState {
    child: Mutex<Option<Child>>,
}

fn api_up() -> bool {
    std::net::TcpStream::connect_timeout(
        &"127.0.0.1:8741".parse().unwrap(),
        std::time::Duration::from_millis(200),
    )
    .is_ok()
}

fn kill_port_listeners(port: u16) {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        let _ = Command::new("pkill")
            .args(["-f", &format!("rivetd")])
            .status();
        // Prefer precise kill via lsof when available.
        if let Ok(output) = Command::new("lsof")
            .args(["-ti", &format!("tcp:{port}")])
            .output()
        {
            let pids = String::from_utf8_lossy(&output.stdout);
            for pid in pids.split_whitespace() {
                let _ = Command::new("kill").arg(pid).status();
            }
        }
    }
}

fn stop_rivetd(app: &AppHandle) {
    if let Some(state) = app.try_state::<RivetdState>() {
        if let Some(mut child) = state.child.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    // Sidecar path may not store a Child handle — clear the control port.
    kill_port_listeners(8741);
}

fn spawn_rivetd(app: &AppHandle) -> Result<(), String> {
    if api_up() {
        return Ok(());
    }

    // Prefer Tauri sidecar when bundled.
    if let Ok(sidecar) = app.shell().sidecar("rivetd") {
        match sidecar.spawn() {
            Ok((_rx, _child)) => {
                for _ in 0..30 {
                    if api_up() {
                        return Ok(());
                    }
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                return Ok(());
            }
            Err(err) => {
                eprintln!("sidecar rivetd failed: {err}; falling back to PATH/dev binary");
            }
        }
    }

    let candidates = [
        std::env::var_os("RIVETD_BIN").map(std::path::PathBuf::from),
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join("rivetd"))),
        Some(
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../../target/debug/rivetd"),
        ),
        Some(
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../../target/release/rivetd"),
        ),
    ];

    for candidate in candidates.into_iter().flatten() {
        if !candidate.is_file() {
            continue;
        }
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
            Err(err) => eprintln!("spawn {} failed: {err}", candidate.display()),
        }
    }
    Err("rivetd not found — run cargo build -p rivet-runtime or bundle the sidecar".into())
}

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn open_wiki_dir(path: String) -> Result<(), String> {
    reveal_path(path)
}

#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    let p = std::path::PathBuf::from(&path);
    if !p.exists() {
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        } else {
            std::fs::create_dir_all(&p).map_err(|e| e.to_string())?;
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
fn ensure_rivetd(app: AppHandle) -> Result<bool, String> {
    spawn_rivetd(&app)?;
    Ok(api_up())
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
            ensure_rivetd
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let _ = spawn_rivetd(&handle);

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
        if let RunEvent::Exit = event {
            stop_rivetd(app_handle);
        }
    });
}
