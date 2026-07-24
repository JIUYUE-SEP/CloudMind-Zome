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

#[tokio::test]
async fn test_grpc_health_reflects_supervisor_state() {
    let _lock = PORT_LOCK.lock().await;
    let tmp = temp_data_dir();
    let server = tokio::spawn(async { server::serve().await });
    sleep(Duration::from_millis(500)).await;

    let mut client = ZomeSidecarClient::connect("http://127.0.0.1:50051")
        .await
        .expect("connect to gRPC server");
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
    let server = tokio::spawn(async { server::serve().await });
    sleep(Duration::from_millis(500)).await;

    let mut client = ZomeSidecarClient::connect("http://127.0.0.1:50051")
        .await
        .expect("connect to gRPC server");
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
    let server = tokio::spawn(async { server::serve().await });
    sleep(Duration::from_millis(500)).await;

    let client = ZomeSidecarClient::connect("http://127.0.0.1:50051")
        .await
        .expect("connect to gRPC server");

    let mut handles = Vec::new();
    for i in 0..50 {
        let mut c = client.clone();
        handles.push(tokio::spawn(async move {
            c.upsert(UpsertRequest {
                agent_id: "concurrent-grpc-agent".to_string(),
                doc_id: format!("doc{}", i),
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
    let server = tokio::spawn(async { server::serve().await });
    sleep(Duration::from_millis(500)).await;

    let mut client = ZomeSidecarClient::connect("http://127.0.0.1:50051")
        .await
        .expect("connect to gRPC server");
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
    let server = tokio::spawn(async { server::serve().await });
    sleep(Duration::from_millis(500)).await;

    let mut client = ZomeSidecarClient::connect("http://127.0.0.1:50051")
        .await
        .expect("connect to gRPC server");
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
