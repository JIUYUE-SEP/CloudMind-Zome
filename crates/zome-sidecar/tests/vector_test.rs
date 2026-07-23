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

    let results = state.write().await.search(&[1.0, 0.0, 0.0], 1);
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

    let results = state.write().await.search(&[1.0, 0.0, 0.0], 2);
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

    let results = state.write().await.search(&[1.0, 0.0, 0.0], 1);
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

    let results = state.write().await.search(&[1.0, 0.0, 0.0], 1000);
    assert_eq!(results.len(), 100);
    assert_eq!(results[0].0, "doc0");
    assert!((results[0].1 - 0.0).abs() < f32::EPSILON);
    for i in 1..results.len() {
        assert!(results[i - 1].1 <= results[i].1);
    }

    // Reload from disk and verify persistence.
    let reloaded = get_or_load("concurrent-agent").await.unwrap();
    let reloaded_results = reloaded.write().await.search(&[1.0, 0.0, 0.0], 1000);
    assert_eq!(reloaded_results.len(), 100);

    std::fs::remove_dir_all(&tmp).ok();
}

#[tokio::test]
async fn test_upsert_appends_without_full_rewrite() {
    let _lock = ENV_LOCK.lock().await;
    let tmp = temp_data_dir();
    let state = get_or_load("append-agent").await.unwrap();
    state.write().await.upsert("doc1", &[1.0, 0.0]).await;
    state.write().await.upsert("doc2", &[0.0, 1.0]).await;
    state.write().await.upsert("doc1", &[1.0, 0.0]).await;

    // append-only：3 次 upsert 即 3 行（原实现每次全量重写，恒为去重后的 2 行）
    let path = tmp.join("agents/append-agent/indices/hnsw/embeddings.jsonl");
    let content = std::fs::read_to_string(&path).unwrap();
    assert_eq!(content.lines().count(), 3);

    std::fs::remove_dir_all(&tmp).ok();
}

#[tokio::test]
async fn test_load_dedups_duplicate_doc_ids_last_wins() {
    let _lock = ENV_LOCK.lock().await;
    let tmp = temp_data_dir();
    // 手工构造 append-only 文件：doc1 先 [1,0] 后 [0,1]，加载时后行覆盖前行
    let dir = tmp.join("agents/dedup-agent/indices/hnsw");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("embeddings.jsonl"),
        "{\"doc_id\":\"doc1\",\"embedding\":[1.0,0.0]}\n\
         {\"doc_id\":\"doc2\",\"embedding\":[0.0,1.0]}\n\
         {\"doc_id\":\"doc1\",\"embedding\":[0.0,1.0]}\n",
    )
    .unwrap();

    let state = get_or_load("dedup-agent").await.unwrap();
    // 查询 [1,0]：若 doc1 以最后一条 [0,1] 生效，所有结果距离都应为 1（无零距离命中）
    let results = state.write().await.search(&[1.0, 0.0], 10);
    assert_eq!(results.len(), 2);
    assert!(results.iter().all(|(_, d)| *d > 0.5));

    std::fs::remove_dir_all(&tmp).ok();
}

#[tokio::test]
async fn test_sanitize_agent_id_rejects_invalid() {
    let result = get_or_load("../bad").await;
    assert!(result.is_err());
}

/// P0-5：增量插入立即可检索——每次 upsert 后 search 都能命中最新点，无需任何重建
#[tokio::test]
async fn test_incremental_upsert_immediately_searchable() {
    let _lock = ENV_LOCK.lock().await;
    let tmp = temp_data_dir();
    let state = get_or_load("incr-agent").await.unwrap();

    state.write().await.upsert("far", &[0.0, 1.0, 0.0]).await;
    state.write().await.upsert("near", &[0.9, 0.1, 0.0]).await;
    let r = state.read().await.search(&[1.0, 0.0, 0.0], 1);
    assert_eq!(r[0].0, "near");

    state.write().await.upsert("nearest", &[0.99, 0.01, 0.0]).await;
    let r2 = state.read().await.search(&[1.0, 0.0, 0.0], 1);
    assert_eq!(r2[0].0, "nearest");

    std::fs::remove_dir_all(&tmp).ok();
}

/// P0-5：重复 upsert 同 doc_id，search 去重且以最新向量为准（旧点成孤儿不得命中）
#[tokio::test]
async fn test_search_reupserted_doc_latest_vector_wins() {
    let _lock = ENV_LOCK.lock().await;
    let tmp = temp_data_dir();
    let state = get_or_load("reupsert-agent").await.unwrap();

    state.write().await.upsert("doc1", &[1.0, 0.0]).await;
    state.write().await.upsert("doc2", &[0.0, 1.0]).await;
    state.write().await.upsert("doc1", &[0.0, 1.0]).await;

    let results = state.read().await.search(&[1.0, 0.0], 10);
    assert_eq!(results.len(), 2);
    assert_eq!(results.iter().filter(|(id, _)| id == "doc1").count(), 1);
    // doc1 的最新向量是 [0,1]：对查询 [1,0] 所有命中距离都应为 1
    assert!(results.iter().all(|(_, d)| *d > 0.5));

    std::fs::remove_dir_all(&tmp).ok();
}

/// P0-5：持续 upsert 期间 search 不被阻塞（原全量重建持写锁，search 会卡到重建完成）
#[tokio::test]
async fn test_search_not_blocked_during_continuous_upserts() {
    let _lock = ENV_LOCK.lock().await;
    let tmp = temp_data_dir();
    let state = get_or_load("nonblock-agent").await.unwrap();
    // 先种一条，保证 search 有内容可检
    state.write().await.upsert("seed", &[1.0; 64]).await;

    let writer = {
        let state = Arc::clone(&state);
        tokio::spawn(async move {
            for i in 0..3000u32 {
                let v: Vec<f32> = (0..64).map(|j| ((i * 31 + j) % 17) as f32).collect();
                state.write().await.upsert(&format!("d{}", i), &v).await;
            }
        })
    };

    let mut max_ms = 0f64;
    let mut hits = 0usize;
    for i in 0..30u32 {
        let q: Vec<f32> = (0..64).map(|j| ((i + j) % 7) as f32).collect();
        let t = std::time::Instant::now();
        let results = state.read().await.search(&q, 10);
        hits += results.len();
        max_ms = max_ms.max(t.elapsed().as_secs_f64() * 1000.0);
    }
    writer.await.unwrap();
    assert!(hits > 0);
    // 旧实现 3000 条重建是秒级；增量插入下单次 search 应在毫秒级
    assert!(max_ms < 500.0, "search blocked during upserts: max {max_ms:.1}ms");

    std::fs::remove_dir_all(&tmp).ok();
}

/// P0-5/M9：embeddings.jsonl 行数远超唯一文档数时，启动加载触发 compaction 重写去重
#[tokio::test]
async fn test_startup_compaction_rewrites_duplicated_jsonl() {
    let _lock = ENV_LOCK.lock().await;
    let tmp = temp_data_dir();
    let dir = tmp.join("agents/compact-agent/indices/hnsw");
    std::fs::create_dir_all(&dir).unwrap();
    let mut content = String::new();
    for i in 0..150u32 {
        let doc = ["a", "b", "c"][(i % 3) as usize];
        content.push_str(&format!("{{\"doc_id\":\"{}\",\"embedding\":[1.0,{}]}}\n", doc, i));
    }
    std::fs::write(dir.join("embeddings.jsonl"), content).unwrap();

    let _state = get_or_load("compact-agent").await.unwrap();
    let after = std::fs::read_to_string(dir.join("embeddings.jsonl")).unwrap();
    // 150 行压成 3 行，且每 doc 保留最后一次写入（147/148/149）
    assert_eq!(after.lines().count(), 3);
    assert!(after.contains("147.0"));
    assert!(after.contains("148.0"));
    assert!(after.contains("149.0"));

    std::fs::remove_dir_all(&tmp).ok();
}
