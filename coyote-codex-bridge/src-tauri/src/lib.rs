#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::{
    fs::{create_dir_all, read_to_string, write, File},
    io::{self, Read, Write},
    net::TcpStream,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    thread,
    time::Duration,
};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, State, WindowEvent};

const TRAY_ID: &str = "coyote-main-tray";
const MENU_SHOW_ID: &str = "tray-show";
const MENU_PAUSE_ID: &str = "tray-pause";
const MENU_EXIT_ID: &str = "tray-exit";
const WINDOW_SETTINGS_FILE: &str = "window-settings.txt";
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

struct AppState {
    backend: Mutex<Option<Child>>,
    run_in_background: AtomicBool,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_run_in_background,
            set_run_in_background
        ])
        .setup(|app| {
            let backend = spawn_portable_backend()?;
            let run_in_background = read_run_in_background()?;
            app.manage(AppState {
                backend: Mutex::new(backend),
                run_in_background: AtomicBool::new(run_in_background),
            });
            setup_tray(app, run_in_background)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let Some(state) = window.try_state::<AppState>() {
                match event {
                    WindowEvent::CloseRequested { api, .. } => {
                        if state.run_in_background.load(Ordering::Relaxed) {
                            api.prevent_close();
                            let _ = window.hide();
                            let _ = set_tray_visible(window.app_handle(), true);
                        } else {
                            stop_backend(&state);
                            window.app_handle().exit(0);
                        }
                    }
                    WindowEvent::Destroyed => stop_backend(&state),
                    _ => {}
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running CoyoteCoder");
}

#[tauri::command]
fn get_run_in_background(state: State<'_, AppState>) -> bool {
    state.run_in_background.load(Ordering::Relaxed)
}

#[tauri::command]
fn set_run_in_background(
    enabled: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.run_in_background.store(enabled, Ordering::Relaxed);
    write_run_in_background(enabled).map_err(|error| error.to_string())?;
    set_tray_visible(&app, enabled).map_err(|error| error.to_string())?;
    Ok(())
}

fn spawn_portable_backend() -> Result<Option<Child>, io::Error> {
    let exe_dir = current_exe_dir()?;
    let backend_path = exe_dir.join(backend_binary_name());
    if !backend_path.is_file() {
        return Ok(None);
    }

    let log_dir = exe_dir.join("logs");
    create_dir_all(&log_dir)?;

    let stdout = File::create(log_dir.join("coyote-backend.out.log"))?;
    let stderr = File::create(log_dir.join("coyote-backend.err.log"))?;

    let mut command = Command::new(backend_path);
    command
        .current_dir(&exe_dir)
        .env("COYOTE_CONFIG", "config.yaml")
        .env("PORT", "8787")
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));

    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    command.spawn().map(Some)
}

fn current_exe_dir() -> Result<PathBuf, io::Error> {
    let exe = std::env::current_exe()?;
    Ok(exe.parent().unwrap_or_else(|| Path::new(".")).to_path_buf())
}

fn backend_binary_name() -> &'static str {
    if cfg!(windows) {
        "coyote-backend.exe"
    } else {
        "coyote-backend"
    }
}

fn stop_backend(state: &AppState) {
    if let Ok(mut backend) = state.backend.lock() {
        if let Some(child) = backend.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        *backend = None;
    }
}

fn setup_tray(app: &tauri::App, visible: bool) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, MENU_SHOW_ID, "打开窗口", true, None::<&str>)?;
    let pause_item = MenuItem::with_id(app, MENU_PAUSE_ID, "暂停反馈", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let exit_item = MenuItem::with_id(app, MENU_EXIT_ID, "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &pause_item, &separator, &exit_item])?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip("CoyoteCoder")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_SHOW_ID => show_main_window(app),
            MENU_PAUSE_ID => {
                thread::spawn(|| {
                    let _ = pause_feedback();
                });
            }
            MENU_EXIT_ID => {
                let state = app.state::<AppState>();
                stop_backend(&state);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    let tray = builder.build(app)?;
    tray.set_visible(visible)?;
    Ok(())
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn set_tray_visible(app: &AppHandle, visible: bool) -> tauri::Result<()> {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_visible(visible)?;
    }
    Ok(())
}

fn read_run_in_background() -> Result<bool, io::Error> {
    let path = window_settings_path()?;
    match read_to_string(path) {
        Ok(content) => Ok(content
            .lines()
            .any(|line| line.trim().eq_ignore_ascii_case("runInBackground=true"))),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

fn write_run_in_background(enabled: bool) -> Result<(), io::Error> {
    let value = if enabled {
        "runInBackground=true\n"
    } else {
        "runInBackground=false\n"
    };
    write(window_settings_path()?, value)
}

fn window_settings_path() -> Result<PathBuf, io::Error> {
    Ok(current_exe_dir()?.join(WINDOW_SETTINGS_FILE))
}

fn pause_feedback() -> Result<(), io::Error> {
    let mut stream = TcpStream::connect(("127.0.0.1", 8787))?;
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;
    stream.write_all(
        b"POST /ui/stop HTTP/1.1\r\nHost: 127.0.0.1:8787\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
    )?;
    stream.flush()?;

    let mut response = [0; 128];
    let _ = stream.read(&mut response);
    Ok(())
}
