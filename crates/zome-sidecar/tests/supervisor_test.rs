use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use zome_sidecar::supervisor;

static PORT_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// 在 8848 上挂一个 stub /health 服务，模拟"已有健康 engine 在跑"的收编场景
async fn stub_health_server() -> tokio::task::JoinHandle<()> {
    let listener = TcpListener::bind("127.0.0.1:8848")
        .await
        .expect("bind 8848 for stub engine");
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                break;
            };
            tokio::spawn(async move {
                let body = "{\"status\":\"ok\"}";
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                // 先读掉请求再写响应：Windows 上带未读接收数据关 socket 会 RST（10053）
                let mut buf = [0u8; 4096];
                let _ = socket.read(&mut buf).await;
                let _ = socket.write_all(response.as_bytes()).await;
                let _ = socket.shutdown().await;
            });
        }
    })
}

/// P0-3 / 架构 P3：收编路径（发现已有健康 engine）也必须注册进 SUPERVISOR 纳入监控，
/// 否则被收编的 engine 崩溃后 restart() 对 None 静默无操作，恢复闭环断裂。
#[tokio::test]
async fn adopted_engine_is_registered_for_monitoring() {
    let _lock = PORT_LOCK.lock().await;
    // 清理可能的前置状态，保证断言只反映本次收编
    supervisor::shutdown().await;
    assert!(!supervisor::has_supervised_engine().await);

    let stub = stub_health_server().await;
    tokio::time::sleep(Duration::from_millis(200)).await;

    // 探针：先确认 stub 应答正常，排除环境干扰
    let probe = reqwest::get("http://127.0.0.1:8848/health").await;
    assert!(probe.is_ok(), "stub health probe failed: {probe:?}");

    supervisor::spawn_node_engine()
        .await
        .expect("adopt healthy engine");
    assert!(
        supervisor::has_supervised_engine().await,
        "adopted engine must be registered into SUPERVISOR"
    );

    // 收编的 engine 不是我们的 child：shutdown 不得误杀，stub 应仍在响应
    supervisor::shutdown().await;
    assert!(supervisor::is_node_healthy().await);

    stub.abort();
}
