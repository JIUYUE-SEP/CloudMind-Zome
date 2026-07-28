mod commands;
mod sidecar;

use tauri::Manager;

/// 日志目录（P4-2，体验 review O-B2）：数据目录下的 logs/ 子目录。
/// 与 sidecar data_dir()（crates/zome-sidecar/src/lib.rs）同一契约——
/// CLOUDMIND_DATA_DIR 优先，兜底 dirs::data_local_dir()/cloudmind-zome。
fn log_dir() -> std::path::PathBuf {
    if let Ok(dir) = std::env::var("CLOUDMIND_DATA_DIR") {
        return std::path::PathBuf::from(dir).join("logs");
    }
    dirs::data_local_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("cloudmind-zome")
        .join("logs")
}

/// 文件 writer（独立函数便于测试）：日轮转、最多保留 7 份。
/// 返回 (writer, guard)——guard 必须活到进程退出（drop 时 flush 并停写入线程）。
fn build_file_writer(
    dir: &std::path::Path,
) -> anyhow::Result<(
    tracing_appender::non_blocking::NonBlocking,
    tracing_appender::non_blocking::WorkerGuard,
)> {
    std::fs::create_dir_all(dir)?;
    let appender = tracing_appender::rolling::Builder::new()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix("desktop")
        .max_log_files(7)
        .build(dir)?;
    Ok(tracing_appender::non_blocking(appender))
}

fn main() {
    // P4-2：desktop 日志落盘——tracing 双写 stdout 与数据目录 logs/。
    // 统一链覆盖全栈：sidecar 的 stdout（含 engine pino 输出与 supervisor
    // 重启日志）已被 Tauri 捕获并喂给 tracing（sidecar.rs CommandEvent），
    // engine 侧无需自己写文件（方案取舍见本提交 message）。
    let Some((file_writer, guard)) = build_file_writer(&log_dir()).ok() else {
        // 日志目录不可用不阻断启动（退化为仅 stdout，与原行为一致）
        eprintln!("log dir unavailable, falling back to stdout-only logging");
        tracing_subscriber::fmt::init();
        run();
        return;
    };
    let _guard = guard;

    use tracing_subscriber::prelude::*;
    tracing_subscriber::registry()
        .with(tracing_subscriber::fmt::layer().with_writer(std::io::stdout))
        .with(
            tracing_subscriber::fmt::layer()
                .with_writer(move || file_writer.clone())
                .with_ansi(false),
        )
        .init();

    run();
}

fn run() {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_dir_respects_env_override() {
        unsafe {
            std::env::set_var("CLOUDMIND_DATA_DIR", "/tmp/zome-log-dir-test");
        }
        assert_eq!(log_dir(), std::path::PathBuf::from("/tmp/zome-log-dir-test/logs"));
        unsafe {
            std::env::remove_var("CLOUDMIND_DATA_DIR");
        }
        assert_eq!(
            log_dir(),
            dirs::data_local_dir()
                .unwrap_or_else(|| std::path::PathBuf::from("."))
                .join("cloudmind-zome")
                .join("logs")
        );
    }

    #[test]
    fn file_writer_creates_log_file_under_logs_dir() {
        let dir = std::env::temp_dir().join(format!("zome-log-writer-test-{}", std::process::id()));
        let (writer, guard) = build_file_writer(&dir).expect("build file writer");
        {
            use tracing_subscriber::prelude::*;
            let subscriber = tracing_subscriber::registry().with(
                tracing_subscriber::fmt::layer()
                    .with_writer(move || writer.clone())
                    .with_ansi(false),
            );
            tracing::subscriber::with_default(subscriber, || {
                tracing::info!("zome-log-writer-marker");
            });
        }
        drop(guard); // flush
        let content = std::fs::read_dir(&dir)
            .expect("logs dir")
            .filter_map(|e| e.ok())
            .map(|e| std::fs::read_to_string(e.path()).unwrap_or_default())
            .collect::<Vec<_>>()
            .join("");
        assert!(content.contains("zome-log-writer-marker"), "log file content missing marker");
        std::fs::remove_dir_all(&dir).ok();
    }
}
