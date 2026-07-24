//! P1-3 数据目录统一：旧默认目录（~/.cloudmind-zome）一次性迁移的显式路径测试

use std::fs;
use std::path::PathBuf;

fn tmp_root(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "zome-migrate-test-{}-{}",
        name,
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn test_migrate_moves_files_and_removes_old_dir() {
    let root = tmp_root("basic");
    let old = root.join("old");
    let new = root.join("new");
    fs::create_dir_all(old.join("agents").join("a1")).unwrap();
    fs::write(old.join("config.json"), "{}").unwrap();
    fs::write(old.join("agents").join("a1").join("agent.json"), "{}").unwrap();
    // 新树已有 sidecar 写的向量索引（统一前两棵树的真实形态）
    fs::create_dir_all(new.join("agents").join("a1").join("indices").join("hnsw")).unwrap();
    fs::write(
        new.join("agents").join("a1").join("indices").join("hnsw").join("embeddings.jsonl"),
        "x",
    )
    .unwrap();

    let moved = zome_sidecar::migrate_dir_contents(&old, &new).unwrap();
    assert_eq!(moved, 2);
    assert!(new.join("config.json").exists());
    assert!(new.join("agents").join("a1").join("agent.json").exists());
    // 新树的向量索引原样保留
    assert_eq!(
        fs::read_to_string(
            new.join("agents").join("a1").join("indices").join("hnsw").join("embeddings.jsonl")
        )
        .unwrap(),
        "x"
    );
    // 全部移完：旧目录已删除
    assert!(!old.exists());

    fs::remove_dir_all(&root).ok();
}

#[test]
fn test_migrate_keeps_newer_file_on_collision_and_keeps_old_dir() {
    let root = tmp_root("collision");
    let old = root.join("old");
    let new = root.join("new");
    fs::create_dir_all(&old).unwrap();
    fs::create_dir_all(&new).unwrap();
    fs::write(old.join("config.json"), "old").unwrap();
    fs::write(new.join("config.json"), "new").unwrap();

    let moved = zome_sidecar::migrate_dir_contents(&old, &new).unwrap();
    assert_eq!(moved, 0);
    // 撞车保留新版，旧目录保留不丢数据
    assert_eq!(fs::read_to_string(new.join("config.json")).unwrap(), "new");
    assert!(old.join("config.json").exists());

    fs::remove_dir_all(&root).ok();
}

#[test]
fn test_migrate_no_old_dir_is_noop() {
    let root = tmp_root("noop");
    let moved = zome_sidecar::migrate_dir_contents(&root.join("missing"), &root.join("new")).unwrap();
    assert_eq!(moved, 0);
    fs::remove_dir_all(&root).ok();
}
