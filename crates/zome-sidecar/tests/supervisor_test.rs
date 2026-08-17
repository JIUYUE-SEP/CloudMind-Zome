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
    // 数据目录隔离（H9 起收编会读 engine.pid）：防止开发机真实 pidfile
    // 指向活 engine 时被本测试击杀
    let tmp = std::env::temp_dir().join(format!("zome-sidecar-adopt-test-{}", std::process::id()));
    std::fs::remove_dir_all(&tmp).ok();
    std::fs::create_dir_all(&tmp).unwrap();
    zome_sidecar::set_data_dir_override(&tmp);

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

    // 无 pidfile 时收编维持旧语义：shutdown 不杀任何进程，stub 应仍在响应
    supervisor::shutdown().await;
    assert!(supervisor::is_node_healthy().await);

    stub.abort();
    std::fs::remove_dir_all(&tmp).ok();
}

/// H9 恢复闭环：收编时从 engine.pid 读到 pid 后，shutdown 能校验身份并击杀
/// 收编的 engine（此前对 child=None 空操作，挂死的 engine 永远占住 8848）。
#[cfg(target_os = "linux")]
#[tokio::test]
async fn adopted_engine_with_pidfile_is_killed_on_shutdown() {
    let _lock = PORT_LOCK.lock().await;
    let tmp = std::env::temp_dir().join(format!(
        "zome-sidecar-adopt-kill-test-{}",
        std::process::id()
    ));
    std::fs::remove_dir_all(&tmp).ok();
    std::fs::create_dir_all(&tmp).unwrap();
    zome_sidecar::set_data_dir_override(&tmp);

    // 伪装 engine：argv0 含 bootstrap.js（/proc cmdline 身份校验通过）
    let mut fake = std::process::Command::new("bash")
        .args(["-c", "exec -a 'node /tmp/bootstrap.js' sleep 30"])
        .spawn()
        .expect("spawn fake engine");
    // spawn（fork）到 exec 完成有窗口期：/proc cmdline 短暂为空，等它就绪
    for _ in 0..100 {
        let ready = std::fs::read(format!("/proc/{}/cmdline", fake.id()))
            .map(|c| !c.is_empty())
            .unwrap_or(false);
        if ready {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    std::fs::write(tmp.join("engine.pid"), fake.id().to_string()).unwrap();

    supervisor::shutdown().await;
    let stub = stub_health_server().await;
    tokio::time::sleep(Duration::from_millis(200)).await;

    supervisor::spawn_node_engine()
        .await
        .expect("adopt healthy engine");

    supervisor::shutdown().await;
    // 收编进程已被击杀（僵尸 cmdline 为空：读不到或为空都算死）
    let cmdline = std::fs::read(format!("/proc/{}/cmdline", fake.id())).unwrap_or_default();
    assert!(cmdline.is_empty(), "adopted engine must be killed");
    // pid 已取走：再次 shutdown 不会重复触碰同一 pid
    supervisor::shutdown().await;
    fake.wait().ok(); // 回收僵尸

    stub.abort();
    std::fs::remove_dir_all(&tmp).ok();
}
