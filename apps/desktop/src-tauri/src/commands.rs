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

/// engine 本地鉴权 token（P0-2）：engine 启动时写入数据目录 auth-token 文件，
/// 前端拿到后对所有 REST（Bearer）/WS（子协议）请求携带。
/// 前端在 backend 就绪前就可能发起调用，按 wait_for_backend 同一节奏轮询等待文件出现。
#[tauri::command]
pub async fn get_engine_token(app: tauri::AppHandle) -> Result<String, String> {
    let path = auth_token_path(&app);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        if let Ok(content) = tokio::fs::read_to_string(&path).await {
            let token = content.trim().to_string();
            if !token.is_empty() {
                return Ok(token);
            }
        }
        if std::time::Instant::now() >= deadline {
            return Err("engine auth token not ready".to_string());
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
}

/// 与 engine 侧 getDataDir() 的解析一致：CLOUDMIND_DATA_DIR 优先，兜底 ~/.cloudmind-zome
fn auth_token_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    use tauri::Manager;
    if let Ok(dir) = std::env::var("CLOUDMIND_DATA_DIR") {
        return std::path::PathBuf::from(dir).join("auth-token");
    }
    app.path()
        .home_dir()
        .unwrap_or_default()
        .join(".cloudmind-zome")
        .join("auth-token")
}
