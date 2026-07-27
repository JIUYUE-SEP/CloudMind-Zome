use tauri::State;

use crate::sidecar::SidecarState;

#[tauri::command]
pub async fn get_backend_url(state: State<'_, SidecarState>) -> Result<String, String> {
    state
        .backend_url
        .lock()
        .await
        .clone()
        .ok_or_else(|| "backend not ready".to_string())
}

/// engine 本地鉴权 token（P0-2）：engine 启动时写入数据目录 auth-token 文件，
/// 前端拿到后对所有 REST（Bearer）/WS（子协议）请求携带。
/// 前端在 backend 就绪前就可能发起调用，按 wait_for_backend 同一节奏轮询等待文件出现。
#[tauri::command]
pub async fn get_engine_token() -> Result<String, String> {
    let candidates = auth_token_candidates();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        if let Some(token) = read_engine_token(&candidates).await {
            return Ok(token);
        }
        if std::time::Instant::now() >= deadline {
            return Err("engine auth token not ready".to_string());
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
}

/// engine auth-token 候选路径（P1 review B1 修复）：
/// 主路径与 sidecar data_dir()（crates/zome-sidecar/src/lib.rs）同源——
/// CLOUDMIND_DATA_DIR 优先，兜底 dirs::data_local_dir()/cloudmind-zome。
/// P1-3 起 supervisor 给 engine 注入该目录，token 写在那里；此前本函数兜底
/// ~/.cloudmind-zome 导致桌面端永远读不到（30s 轮询超时、全链路鉴权失败）。
/// 旧默认 ~/.cloudmind-zome/auth-token 仅作读取兜底：dev 场景 engine 独立跑
/// （未经 supervisor 注入 env）仍写旧路径；生产下旧目录已被
/// migrate_legacy_data_dir 搬走，兜底自然失效。按序前者优先。
fn auth_token_candidates() -> Vec<std::path::PathBuf> {
    auth_token_candidates_with(
        std::env::var("CLOUDMIND_DATA_DIR").ok(),
        dirs::data_local_dir(),
        dirs::home_dir(),
    )
}

/// 纯函数版（测试注入路径来源）
fn auth_token_candidates_with(
    env_dir: Option<String>,
    data_local: Option<std::path::PathBuf>,
    home: Option<std::path::PathBuf>,
) -> Vec<std::path::PathBuf> {
    use std::path::PathBuf;
    let mut candidates = Vec::new();
    let primary_dir = env_dir
        .map(PathBuf::from)
        .or_else(|| data_local.map(|d| d.join("cloudmind-zome")));
    if let Some(dir) = primary_dir {
        candidates.push(dir.join("auth-token"));
    }
    if let Some(home) = home {
        let legacy = home.join(".cloudmind-zome").join("auth-token");
        if !candidates.contains(&legacy) {
            candidates.push(legacy);
        }
    }
    candidates
}

/// 按候选顺序读第一个存在且非空的 token
async fn read_engine_token(paths: &[std::path::PathBuf]) -> Option<String> {
    for path in paths {
        if let Ok(content) = tokio::fs::read_to_string(path).await {
            let token = content.trim().to_string();
            if !token.is_empty() {
                return Some(token);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn candidates(env: Option<&str>, data_local: Option<&str>, home: Option<&str>) -> Vec<PathBuf> {
        auth_token_candidates_with(
            env.map(str::to_string),
            data_local.map(PathBuf::from),
            home.map(PathBuf::from),
        )
    }

    #[test]
    fn primary_matches_sidecar_data_dir_env_override() {
        // 与 sidecar data_dir() 同源（crates/zome-sidecar/src/lib.rs）：
        // CLOUDMIND_DATA_DIR 设置时直接使用
        let c = candidates(Some("/tmp/env-dir"), Some("/tmp/local"), Some("/tmp/home"));
        assert_eq!(c[0], PathBuf::from("/tmp/env-dir").join("auth-token"));
    }

    #[test]
    fn primary_matches_sidecar_data_dir_default_and_legacy_is_fallback() {
        // 默认与 sidecar data_dir() 一致：data_local_dir()/cloudmind-zome；
        // 旧默认 ~/.cloudmind-zome/auth-token 仅作兜底排第二
        let c = candidates(None, Some("/tmp/local"), Some("/tmp/home"));
        assert_eq!(
            c[0],
            PathBuf::from("/tmp/local").join("cloudmind-zome").join("auth-token")
        );
        assert_eq!(
            c[1],
            PathBuf::from("/tmp/home").join(".cloudmind-zome").join("auth-token")
        );
    }

    #[test]
    fn legacy_not_duplicated_when_same_as_primary() {
        let c = candidates(
            Some("/tmp/home/.cloudmind-zome"),
            None,
            Some("/tmp/home"),
        );
        assert_eq!(c.len(), 1);
    }

    #[tokio::test]
    async fn read_prefers_primary_then_falls_back_to_legacy() {
        let tmp = std::env::temp_dir().join(format!("desktop-token-test-{}", std::process::id()));
        let primary = tmp.join("new/auth-token");
        let legacy = tmp.join("old/auth-token");
        std::fs::create_dir_all(primary.parent().unwrap()).unwrap();
        std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();

        // 仅旧路径有 token（dev 场景 engine 独立跑写旧目录）→ 兜底读到
        std::fs::write(&legacy, "legacy-token\n").unwrap();
        let paths = vec![primary.clone(), legacy.clone()];
        assert_eq!(read_engine_token(&paths).await.as_deref(), Some("legacy-token"));

        // 新路径出现 → 优先新路径
        std::fs::write(&primary, "primary-token\n").unwrap();
        assert_eq!(read_engine_token(&paths).await.as_deref(), Some("primary-token"));

        // 都没有 → None（调用方继续轮询）
        std::fs::remove_file(&primary).unwrap();
        std::fs::remove_file(&legacy).unwrap();
        assert_eq!(read_engine_token(&paths).await, None);

        std::fs::remove_dir_all(&tmp).ok();
    }
}
