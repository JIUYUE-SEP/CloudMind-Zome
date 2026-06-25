use tauri::State;

use crate::sidecar::SidecarState;

#[tauri::command]
pub async fn get_backend_url(state: State<'_, SidecarState>) -> Result<String, String> {
    state
        .backend_url
        .lock()
        .await
        .clone()
        .ok_or_else(|| "backend not ready".to_string())
}
