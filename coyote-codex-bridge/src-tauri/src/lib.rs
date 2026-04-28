use std::{
    fs::{create_dir_all, File},
    io,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
};
use tauri::{Manager, WindowEvent};

struct BackendProcess(Mutex<Option<Child>>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let backend = spawn_portable_backend()?;
            app.manage(BackendProcess(Mutex::new(backend)));
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, WindowEvent::Destroyed) {
                if let Some(state) = window.try_state::<BackendProcess>() {
                    stop_backend(&state);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running CoyoteCoder");
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

    Command::new(backend_path)
        .current_dir(&exe_dir)
        .env("COYOTE_CONFIG", "config.yaml")
        .env("PORT", "8787")
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr))
        .spawn()
        .map(Some)
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

fn stop_backend(state: &BackendProcess) {
    if let Ok(mut backend) = state.0.lock() {
        if let Some(child) = backend.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        *backend = None;
    }
}
