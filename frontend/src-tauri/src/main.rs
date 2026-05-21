#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::{Command, Stdio};
use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Spawn Python backend as sidecar on startup
            let app_handle = app.handle().clone();
            let backend_path = app_handle
                .path()
                .resolve("../backend/run.py", tauri::path::BaseDirectory::Resource)
                .unwrap_or_default();

            // For dev: try running python directly from project root
            let python_cmd = if cfg!(target_os = "windows") {
                "python"
            } else {
                "python3"
            };

            // Fire-and-forget backend process
            std::thread::spawn(move || {
                let _ = Command::new(python_cmd)
                    .arg("run.py")
                    .current_dir("..")
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn();
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
