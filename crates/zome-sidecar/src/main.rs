use tracing::{info, warn};
use zome_sidecar::{server, supervisor};

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

    supervisor::spawn_node_engine().await?;
    tokio::spawn(supervisor::watch_node_health());

    // gRPC serve 正常不会返回；收到退出信号时先停 server，再级联关闭 node engine，
    // 否则 engine 会变成孤儿进程继续占用 8848 端口。
    tokio::select! {
        res = server::serve() => {
            res?;
        }
        _ = shutdown_signal() => {
            info!("shutdown signal received");
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
