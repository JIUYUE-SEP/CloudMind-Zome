use std::path::PathBuf;
use std::time::Duration;

use tokio::time::sleep;
use tonic::Code;

static PORT_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

use zome_sidecar::server;
use zome_sidecar::zome::{
    DeleteAgentRequest, HealthRequest, SearchRequest, UpsertRequest,
    zome_sidecar_client::ZomeSidecarClient,
};

fn temp_data_dir() -> PathBuf {
    let tmp = std::env::temp_dir().join(format!("zome-sidecar-grpc-test-{}", std::process::id()));
    unsafe { std::env::set_var("CLOUDMIND_DATA_DIR", &tmp) };
    tmp
}

/// 起 gRPC server 并等它就绪：前一个测试 abort 后端口可能短暂不可复用
/// （Windows 上 bind 失败时 serve 任务静默退出，固定 500ms 等待会撞上
/// ConnectionRefused），spawn + 连接带重试。
async fn spawn_server_ready() -> (
    tokio::task::JoinHandle<anyhow::Result<()>>,
    ZomeSidecarClient<tonic::transport::Channel>,
) {
    let mut last_err = String::new();
    for _ in 0..10 {
        let server = tokio::spawn(async { server::serve().await });
        sleep(Duration::from_millis(300)).await;
        match ZomeSidecarClient::connect("http://127.0.0.1:50051").await {
            Ok(client) => return (server, client),
            Err(e) => {
                last_err = e.to_string();
                server.abort();
                sleep(Duration::from_millis(300)).await;
            }
        }
    }
    panic!("connect to gRPC server: {last_err}");
}

#[tokio::test]
async fn test_grpc_health_reflects_supervisor_state() {
    let _lock = PORT_LOCK.lock().await;
    let tmp = temp_data_dir();
    let (server, mut client) = spawn_server_ready().await;
    let response = client
        .health(HealthRequest {})
        .await
        .expect("health rpc")
        .into_inner();

    // No node engine is running in this test, so the supervisor should report degraded.
    assert_eq!(response.status, "degraded");

    server.abort();
    std::fs::remove_dir_all(&tmp).ok();
}

#[tokio::test]
async fn test_grpc_rejects_invalid_agent_id() {
    let _lock = PORT_LOCK.lock().await;
    let tmp = temp_data_dir();
    let (server, mut client) = spawn_server_ready().await;
    let request = UpsertRequest {
        agent_id: "../bad".to_string(),
        doc_id: "doc1".to_string(),
        embedding: vec![1.0, 0.0, 0.0],
    };
    let status = client.upsert(request).await.unwrap_err();
    assert_eq!(status.code(), Code::InvalidArgument);

    server.abort();
    std::fs::remove_dir_all(&tmp).ok();
}

#[tokio::test]
async fn test_grpc_concurrent_upsert_preserves_data() {
    let _lock = PORT_LOCK.lock().await;
    let tmp = temp_data_dir();
    let (server, client) = spawn_server_ready().await;

    let mut handles = Vec::new();
    for i in 0..50 {
        let mut c = client.clone();
        handles.push(tokio::spawn(async move {
            c.upsert(UpsertRequest {
                agent_id: "concurrent-grpc-agent".to_string(),
                doc_id: format!("doc{i}"),
                embedding: vec![i as f32, 0.0, 0.0],
            })
            .await
            .expect("upsert");
        }));
    }
    for handle in handles {
        handle.await.unwrap();
    }

    let mut client = client;
    let response = client
        .search(SearchRequest {
            agent_id: "concurrent-grpc-agent".to_string(),
            query: vec![1.0, 0.0, 0.0],
            top_k: 100,
        })
        .await
        .expect("search")
        .into_inner();

    assert_eq!(response.results.len(), 50);

    server.abort();
    std::fs::remove_dir_all(&tmp).ok();
}

/// P1-3：DeleteAgent RPC 拒绝非法 agent_id（沿用 sanitize 规则）
#[tokio::test]
async fn test_grpc_delete_agent_rejects_invalid_id() {
    let _lock = PORT_LOCK.lock().await;
    let tmp = temp_data_dir();
    let (server, mut client) = spawn_server_ready().await;
    let status = client
        .delete_agent(DeleteAgentRequest {
            agent_id: "../bad".to_string(),
        })
        .await
        .unwrap_err();
    assert_eq!(status.code(), Code::InvalidArgument);

    server.abort();
    std::fs::remove_dir_all(&tmp).ok();
}

/// P1-3：DeleteAgent 后 search 返回空（缓存逐出 + 磁盘清理）
#[tokio::test]
async fn test_grpc_delete_agent_clears_vectors() {
    let _lock = PORT_LOCK.lock().await;
    let tmp = temp_data_dir();
    let (server, mut client) = spawn_server_ready().await;
    client
        .upsert(UpsertRequest {
            agent_id: "grpc-del-agent".to_string(),
            doc_id: "d1".to_string(),
            embedding: vec![1.0, 0.0],
        })
        .await
        .expect("upsert");
    client
        .delete_agent(DeleteAgentRequest {
            agent_id: "grpc-del-agent".to_string(),
        })
        .await
        .expect("delete_agent");

    // 磁盘索引目录已删除（必须在 search 前断言：load_state 会重建空目录）
    assert!(!tmp.join("agents/grpc-del-agent/indices").exists());

    let res = client
        .search(SearchRequest {
            agent_id: "grpc-del-agent".to_string(),
            query: vec![1.0, 0.0],
            top_k: 10,
        })
        .await
        .expect("search")
        .into_inner();
    assert!(res.results.is_empty());

    server.abort();
    std::fs::remove_dir_all(&tmp).ok();
}

/// H10b：空 embedding 直接 invalid_argument（原实现会把 0 维写进索引，
/// 维度永远钉不住且距离求值 panic）
#[tokio::test]
async fn test_grpc_upsert_rejects_empty_embedding() {
    let _lock = PORT_LOCK.lock().await;
    let tmp = temp_data_dir();
    let (server, mut client) = spawn_server_ready().await;
    let status = client
        .upsert(UpsertRequest {
            agent_id: "grpc-dim-empty-agent".to_string(),
            doc_id: "d1".to_string(),
            embedding: vec![],
        })
        .await
        .unwrap_err();
    assert_eq!(status.code(), Code::InvalidArgument);

    server.abort();
    std::fs::remove_dir_all(&tmp).ok();
}

/// H10b：首个非空写入钉住索引维度，此后异维写入 invalid_argument
/// （含期望/实际维度），不再静默吞掉
#[tokio::test]
async fn test_grpc_upsert_rejects_mismatched_dim_after_first_pins() {
    let _lock = PORT_LOCK.lock().await;
    let tmp = temp_data_dir();
    let (server, mut client) = spawn_server_ready().await;
    // 首插钉维 3
    client
        .upsert(UpsertRequest {
            agent_id: "grpc-dim-pin-agent".to_string(),
            doc_id: "ok".to_string(),
            embedding: vec![1.0, 0.0, 0.0],
        })
        .await
        .expect("first upsert pins dim");
    // 异维写入被拒，消息含期望/实际维度
    let status = client
        .upsert(UpsertRequest {
            agent_id: "grpc-dim-pin-agent".to_string(),
            doc_id: "bad".to_string(),
            embedding: vec![1.0, 0.0],
        })
        .await
        .unwrap_err();
    assert_eq!(status.code(), Code::InvalidArgument);
    assert!(
        status.message().contains("index dim is 3") && status.message().contains("got 2"),
        "unexpected message: {}",
        status.message()
    );
    // 被拒的异维向量不可检索（未入索引）
    let res = client
        .search(SearchRequest {
            agent_id: "grpc-dim-pin-agent".to_string(),
            query: vec![1.0, 0.0, 0.0],
            top_k: 10,
        })
        .await
        .expect("search")
        .into_inner();
    assert_eq!(res.results.len(), 1);
    assert_eq!(res.results[0].doc_id, "ok");

    server.abort();
    std::fs::remove_dir_all(&tmp).ok();
}

/// H10b：查询维度与索引维度不一致 → invalid_argument（不 panic、不出错结果）
#[tokio::test]
async fn test_grpc_search_rejects_mismatched_dim() {
    let _lock = PORT_LOCK.lock().await;
    let tmp = temp_data_dir();
    let (server, mut client) = spawn_server_ready().await;
    client
        .upsert(UpsertRequest {
            agent_id: "grpc-dim-search-agent".to_string(),
            doc_id: "d1".to_string(),
            embedding: vec![1.0, 0.0, 0.0],
        })
        .await
        .expect("upsert");

    let status = client
        .search(SearchRequest {
            agent_id: "grpc-dim-search-agent".to_string(),
            query: vec![1.0, 0.0],
            top_k: 10,
        })
        .await
        .unwrap_err();
    assert_eq!(status.code(), Code::InvalidArgument);
    assert!(
        status.message().contains("index dim is 3") && status.message().contains("got 2"),
        "unexpected message: {}",
        status.message()
    );
    // 同维查询正常
    let res = client
        .search(SearchRequest {
            agent_id: "grpc-dim-search-agent".to_string(),
            query: vec![1.0, 0.0, 0.0],
            top_k: 10,
        })
        .await
        .expect("search")
        .into_inner();
    assert_eq!(res.results.len(), 1);

    server.abort();
    std::fs::remove_dir_all(&tmp).ok();
}
