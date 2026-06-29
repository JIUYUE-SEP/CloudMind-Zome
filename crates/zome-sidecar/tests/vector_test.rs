use std::path::PathBuf;
use std::sync::Arc;

use zome_sidecar::vector::get_or_load;

static ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn temp_data_dir() -> PathBuf {
    let tmp =
        std::env::temp_dir().join(format!("zome-sidecar-vector-test-{}-", std::process::id()));
    unsafe { std::env::set_var("CLOUDMIND_DATA_DIR", &tmp) };
    tmp
}

#[tokio::test]
async fn test_vector_search() {
    let _lock = ENV_LOCK.lock().await;
    let tmp = temp_data_dir();
    let state = get_or_load("test-agent").await.unwrap();
    state.write().await.upsert("doc1", &[1.0, 0.0, 0.0]).await;
    state.write().await.upsert("doc2", &[0.0, 1.0, 0.0]).await;

    let results = state.read().await.search(&[1.0, 0.0, 0.0], 1);
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].0, "doc1");

    std::fs::remove_dir_all(&tmp).ok();
}

#[tokio::test]
async fn test_vector_search_top_k() {
    let _lock = ENV_LOCK.lock().await;
    let tmp = temp_data_dir();
    let state = get_or_load("test-agent-topk").await.unwrap();
    state.write().await.upsert("doc1", &[1.0, 0.0, 0.0]).await;
    state.write().await.upsert("doc2", &[0.0, 1.0, 0.0]).await;
    state.write().await.upsert("doc3", &[0.0, 0.0, 1.0]).await;

    let results = state.read().await.search(&[1.0, 0.0, 0.0], 2);
    assert_eq!(results.len(), 2);
    assert_eq!(results[0].0, "doc1");
    assert!((results[0].1 - 0.0).abs() < f32::EPSILON);
    assert!((results[1].1 - 1.0).abs() < f32::EPSILON);

    std::fs::remove_dir_all(&tmp).ok();
}

#[tokio::test]
async fn test_vector_single_doc_linear_search() {
    let _lock = ENV_LOCK.lock().await;
    let tmp = temp_data_dir();
    let state = get_or_load("single-doc-agent").await.unwrap();
    state.write().await.upsert("only", &[1.0, 0.0, 0.0]).await;

    let results = state.read().await.search(&[1.0, 0.0, 0.0], 1);
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].0, "only");
    assert!((results[0].1 - 0.0).abs() < f32::EPSILON);

    std::fs::remove_dir_all(&tmp).ok();
}

#[tokio::test]
async fn test_concurrent_upsert_does_not_lose_data() {
    let _lock = ENV_LOCK.lock().await;
    let tmp = temp_data_dir();
    let state = get_or_load("concurrent-agent").await.unwrap();

    let mut handles = Vec::new();
    for i in 0..100 {
        let state = Arc::clone(&state);
        handles.push(tokio::spawn(async move {
            let mut guard = state.write().await;
            guard
                .upsert(&format!("doc{}", i), &[1.0, i as f32, 0.0])
                .await;
        }));
    }
    for handle in handles {
        handle.await.unwrap();
    }

    let results = state.read().await.search(&[1.0, 0.0, 0.0], 1000);
    assert_eq!(results.len(), 100);
    assert_eq!(results[0].0, "doc0");
    assert!((results[0].1 - 0.0).abs() < f32::EPSILON);
    for i in 1..results.len() {
        assert!(results[i - 1].1 <= results[i].1);
    }

    // Reload from disk and verify persistence.
    let reloaded = get_or_load("concurrent-agent").await.unwrap();
    let reloaded_results = reloaded.read().await.search(&[1.0, 0.0, 0.0], 1000);
    assert_eq!(reloaded_results.len(), 100);

    std::fs::remove_dir_all(&tmp).ok();
}

#[tokio::test]
async fn test_sanitize_agent_id_rejects_invalid() {
    let result = get_or_load("../bad").await;
    assert!(result.is_err());
}
