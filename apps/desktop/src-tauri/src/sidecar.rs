use std::time::Duration;

use tauri::async_runtime::Mutex;
use tauri::Manager;
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;
use tracing::{error, info, warn};

pub struct SidecarState {
    pub backend_url: Mutex<Option<String>>,
    pub sidecar_handle: Mutex<Option<tauri_plugin_shell::process::CommandChild>>,
}

impl SidecarState {
    pub fn new() -> Self {
        Self {
            backend_url: Mutex::new(None),
            sidecar_handle: Mutex::new(None),
        }
    }
}

pub async fn spawn_zome_sidecar<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> anyhow::Result<()> {
    let sidecar_command = app
        .shell()
        .sidecar("zome-sidecar")
        .map_err(|e| anyhow::anyhow!("failed to create sidecar command: {e}"))?;

    info!("spawning zome-sidecar: {:?}", sidecar_command);
    let (mut rx, child) = sidecar_command
        .spawn()
        .map_err(|e| anyhow::anyhow!("failed to spawn sidecar: {e}"))?;

    let state = app.state::<SidecarState>();
    *state.sidecar_handle.lock().await = Some(child);

    let app_handle = app.clone();
    tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    info!("sidecar stdout: {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Stderr(line) => {
                    warn!("sidecar stderr: {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Error(e) => {
                    error!("sidecar error: {e}");
                }
                CommandEvent::Terminated(payload) => {
                    // 意外退出（shutdown 主动收尸会先把 handle take 走，那时是正常路径）：
                    // 不能只记 tracing 日志——kill_on_drop 会连带杀掉 engine，
                    // 前端 WS 随之断开，必须通知前端给用户可见提示（D-B1）
                    let unexpected = app_handle
                        .state::<SidecarState>()
                        .sidecar_handle
                        .lock()
                        .await
                        .is_some();
                    if unexpected {
                        error!(
                            "zome-sidecar terminated unexpectedly: code={:?} signal={:?}",
                            payload.code, payload.signal
                        );
                        use tauri::Emitter;
                        let _ = app_handle.emit("zome://sidecar-terminated", ());
                    } else {
                        info!(
                            "sidecar terminated: code={:?} signal={:?}",
                            payload.code, payload.signal
                        );
                    }
                    break;
                }
                _ => {}
            }
        }
    });

    wait_for_backend(Duration::from_secs(30)).await?;
    *state.backend_url.lock().await = Some("http://127.0.0.1:8848".to_string());
    info!("backend ready at http://127.0.0.1:8848");

    Ok(())
}

async fn wait_for_backend(timeout: Duration) -> anyhow::Result<()> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap_or_default();

    let deadline = tokio::time::Instant::now() + timeout;
    while tokio::time::Instant::now() < deadline {
        if matches!(
            client.get("http://127.0.0.1:8848/health").send().await,
            Ok(resp) if resp.status().is_success()
        ) {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    Err(anyhow::anyhow!("backend did not become healthy within timeout"))
}

pub async fn shutdown<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    info!("shutting down zome-sidecar");
    let state = app.state::<SidecarState>();
    if let Some(child) = state.sidecar_handle.lock().await.take() {
        // 强杀 sidecar 不会运行 Rust 的 kill_on_drop，node engine 会变成孤儿进程占用 8848；
        // Windows 上按进程树杀（/T），Unix 上先 SIGTERM 让 sidecar 级联关闭再兜底。
        #[cfg(windows)]
        {
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &child.pid().to_string(), "/T", "/F"])
                .output();
        }
        #[cfg(not(windows))]
        {
            let _ = std::process::Command::new("kill")
                .arg(child.pid().to_string())
                .output();
            tokio::time::sleep(Duration::from_secs(2)).await;
            let _ = child.kill();
        }
    }
}
