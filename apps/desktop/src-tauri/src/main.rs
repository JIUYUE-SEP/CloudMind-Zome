mod commands;
mod sidecar;

use tauri::Manager;

fn main() {
    tracing_subscriber::fmt::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(sidecar::SidecarState::new())
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = sidecar::spawn_zome_sidecar(&handle).await {
                    tracing::error!("failed to spawn sidecar: {e}");
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let app = window.app_handle().clone();
                tauri::async_runtime::block_on(async move {
                    sidecar::shutdown(&app).await;
                });
            }
        })
        .invoke_handler(tauri::generate_handler![commands::get_backend_url, commands::get_engine_token])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
