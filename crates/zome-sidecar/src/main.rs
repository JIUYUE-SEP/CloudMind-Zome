use std::time::Duration;

use tracing::{error, info, warn};
use zome_sidecar::{server, supervisor};

/// gRPC serve 异常退出后的重试退避（H10a）：对齐 supervisor 的
/// DEGRADED_MONITOR_INTERVAL——永不放弃，但避免无间隔重启风暴
const SERVE_RETRY_INTERVAL: Duration = Duration::from_secs(30);

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();
    info!("zome-sidecar starting");

    // P1-3 数据目录统一：旧默认目录（~/.cloudmind-zome）的一次性迁移，
    // 必须在 spawn engine（注入新目录）之前完成；失败不阻断启动
    match zome_sidecar::migrate_legacy_data_dir() {
        Ok(0) => {}
        Ok(n) => info!(
            "migrated {} entries from legacy data dir (~/.cloudmind-zome)",
            n
        ),
        Err(e) => warn!("legacy data dir migration failed (non-fatal): {e}"),
    }

    // spawn 失败不再整体退出（H10a / D-B1 永不放弃）：记档后照常进入
    // watch_node_health——spawn 失败时已注册空 Supervisor，其 restart 路径
    // 对 engine_entry 错误有 error! 处理，低频重试等入口就位
    if let Err(e) = supervisor::spawn_node_engine().await {
        error!("spawn node engine failed: {e:#}; supervisor keeps retrying in watch loop");
    }
    tokio::spawn(supervisor::watch_node_health());

    // gRPC serve 正常不会返回。serve 出错（如 50051 被占）记档后退避重启
    // （H10a），不再 ? 退出。收到退出信号或 serve 正常返回时：级联关闭
    // node engine，否则 engine 会变成孤儿进程继续占用 8848 端口。
    loop {
        tokio::select! {
            res = server::serve() => {
                match res {
                    Ok(()) => break,
                    Err(e) => {
                        error!("gRPC serve failed: {e:#}; retrying in {SERVE_RETRY_INTERVAL:?}");
                        // 退避期间仍响应退出信号
                        tokio::select! {
                            _ = tokio::time::sleep(SERVE_RETRY_INTERVAL) => {}
                            _ = shutdown_signal() => {
                                info!("shutdown signal received");
                                break;
                            }
                        }
                    }
                }
            }
            _ = shutdown_signal() => {
                info!("shutdown signal received");
                break;
            }
        }
    }
    supervisor::shutdown().await;

    Ok(())
}

#[cfg(windows)]
async fn shutdown_signal() {
    use tokio::signal::windows::{ctrl_c, ctrl_close};
    let mut close = ctrl_close().expect("failed to install ctrl_close handler");
    let mut interrupt = ctrl_c().expect("failed to install ctrl_c handler");
    tokio::select! {
        _ = close.recv() => {},
        _ = interrupt.recv() => {},
    }
}

#[cfg(not(windows))]
async fn shutdown_signal() {
    use tokio::signal::unix::{SignalKind, signal};
    let mut terminate = signal(SignalKind::terminate()).expect("failed to install SIGTERM handler");
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {},
        _ = terminate.recv() => {},
    }
}
