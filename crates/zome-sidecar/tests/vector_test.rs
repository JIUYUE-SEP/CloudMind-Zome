use std::path::PathBuf;
use std::sync::Mutex;

use zome_sidecar::vector::VectorIndex;

static ENV_LOCK: Mutex<()> = Mutex::new(());

fn temp_data_dir() -> PathBuf {
    let tmp = std::env::temp_dir().join(format!("zome-sidecar-vector-test-{}", std::process::id()));
    unsafe { std::env::set_var("CLOUDMIND_DATA_DIR", &tmp) };
    tmp
}

#[tokio::test]
async fn test_vector_search() {
    let _lock = ENV_LOCK.lock().unwrap();
    let tmp = temp_data_dir();
    let mut index = VectorIndex::new("test-agent");
    index.upsert("doc1", &[1.0, 0.0, 0.0]);
    index.upsert("doc2", &[0.0, 1.0, 0.0]);

    let results = index.search(&[1.0, 0.0, 0.0], 1);
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].0, "doc1");

    let _ = std::fs::remove_dir_all(&tmp);
}

#[tokio::test]
async fn test_vector_search_top_k() {
    let _lock = ENV_LOCK.lock().unwrap();
    let tmp = temp_data_dir();
    let mut index = VectorIndex::new("test-agent-topk");
    index.upsert("doc1", &[1.0, 0.0, 0.0]);
    index.upsert("doc2", &[0.0, 1.0, 0.0]);
    index.upsert("doc3", &[0.0, 0.0, 1.0]);

    let results = index.search(&[1.0, 0.0, 0.0], 2);
    assert_eq!(results.len(), 2);
    assert_eq!(results[0].0, "doc1");

    let _ = std::fs::remove_dir_all(&tmp);
}
