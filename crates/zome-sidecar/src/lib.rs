pub mod sandbox;
pub mod server;
pub mod supervisor;
pub mod tokenizer;
pub mod vector;

pub mod zome {
    include!(concat!(env!("OUT_DIR"), "/zome.rs"));
}

use std::path::{Path, PathBuf};

use anyhow::bail;

pub fn sanitize_agent_id(agent_id: &str) -> anyhow::Result<String> {
    if agent_id.is_empty() || agent_id.len() > 64 {
        bail!("invalid agent_id length");
    }
    if agent_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        Ok(agent_id.to_string())
    } else {
        bail!("agent_id contains invalid characters")
    }
}

pub fn project_root() -> anyhow::Result<PathBuf> {
    let mut dir = std::env::current_dir()?;
    loop {
        if dir.join("pnpm-workspace.yaml").exists() || dir.join("package.json").exists() {
            return Ok(dir);
        }
        if !dir.pop() {
            break;
        }
    }
    Ok(std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

pub fn data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("CLOUDMIND_DATA_DIR") {
        return PathBuf::from(dir);
    }
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("cloudmind-zome")
}

/// P1-3 数据目录统一：旧版 engine 默认数据目录（~/.cloudmind-zome）的一次性迁移。
///
/// 统一前 engine 默认写 home 目录、sidecar 默认写 data_local_dir，桌面端两棵树
/// （review M2）；统一后 sidecar 的 data_dir() 是唯一权威源（spawn engine 时注入
/// CLOUDMIND_DATA_DIR）。旧目录里的 config/agents/sessions 必须跟过来，否则升级
/// 后用户记忆"消失"。
///
/// 逐条目 move（rename，同盘瞬时）；目标已存在同名文件时跳过并 warn（旧树不含
/// 向量索引，冲突只可能来自手工放置），目录递归合并。全部移完才删旧目录；
/// 有跳过/失败则保留旧目录不丢数据。显式设置了 CLOUDMIND_DATA_DIR 时不迁移
/// （用户已自己选定位置，旧默认目录里的可能是无关 dev 数据）。
pub fn migrate_legacy_data_dir() -> anyhow::Result<usize> {
    if std::env::var("CLOUDMIND_DATA_DIR").is_ok() {
        return Ok(0);
    }
    let Some(home) = dirs::home_dir() else {
        return Ok(0);
    };
    let old = home.join(".cloudmind-zome");
    let new = data_dir();
    migrate_dir_contents(&old, &new)
}

/// migrate_legacy_data_dir 的显式路径版本（测试可直接构造两个临时目录）。
/// 返回成功移动的条目数。
pub fn migrate_dir_contents(old: &Path, new: &Path) -> anyhow::Result<usize> {
    if old == new || !old.exists() {
        return Ok(0);
    }
    let mut moved = 0usize;
    let mut skipped = 0usize;
    for entry in std::fs::read_dir(old)? {
        let entry = entry?;
        migrate_entry(
            &entry.path(),
            &new.join(entry.file_name()),
            &mut moved,
            &mut skipped,
        );
    }
    if skipped == 0 {
        std::fs::remove_dir_all(old).ok();
    } else {
        tracing::warn!(
            "legacy data dir migration: {} entries skipped, old dir kept at {}",
            skipped,
            old.display()
        );
    }
    Ok(moved)
}

fn migrate_entry(src: &Path, dst: &Path, moved: &mut usize, skipped: &mut usize) {
    if dst.exists() {
        // 目录递归合并（旧树无向量索引、新树可能有，目录层级必然撞车）；
        // 文件撞车跳过保留新版
        if src.is_dir() && dst.is_dir() {
            if let Ok(entries) = std::fs::read_dir(src) {
                for entry in entries.flatten() {
                    migrate_entry(&entry.path(), &dst.join(entry.file_name()), moved, skipped);
                }
            }
            return;
        }
        *skipped += 1;
        tracing::warn!("legacy migration skip existing: {}", dst.display());
        return;
    }
    if let Some(parent) = dst.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match std::fs::rename(src, dst) {
        Ok(_) => *moved += 1,
        Err(e) => {
            *skipped += 1;
            tracing::warn!(
                "legacy migration rename failed {} -> {}: {}",
                src.display(),
                dst.display(),
                e
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_dir_resolution_contract() {
        // B1 同源契约：desktop auth-token 解析（apps/desktop/src-tauri/src/
        // commands.rs）与本函数必须一致——env 优先，兜底 data_local_dir()/cloudmind-zome
        unsafe {
            std::env::set_var("CLOUDMIND_DATA_DIR", "/tmp/zome-data-dir-contract-test");
        }
        assert_eq!(
            data_dir(),
            PathBuf::from("/tmp/zome-data-dir-contract-test")
        );
        unsafe {
            std::env::remove_var("CLOUDMIND_DATA_DIR");
        }
        assert_eq!(
            data_dir(),
            dirs::data_local_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join("cloudmind-zome")
        );
    }
}
