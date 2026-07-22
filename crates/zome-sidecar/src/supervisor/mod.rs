use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tracing::{error, info, warn};

use crate::project_root;

const HEALTH_URL: &str = "http://127.0.0.1:8848/health";
const HEALTH_CHECK_INTERVAL: Duration = Duration::from_secs(5);
const STARTUP_GRACE_PERIOD: Duration = Duration::from_secs(30);
const STARTUP_CHECK_INTERVAL: Duration = Duration::from_secs(1);
const UNHEALTHY_FAILURE_THRESHOLD: u32 = 3;
const MAX_RESTART_RETRIES: u32 = 5;

static SUPERVISOR: std::sync::LazyLock<Mutex<Option<Supervisor>>> =
    std::sync::LazyLock::new(|| Mutex::new(None));

#[derive(Clone)]
pub struct Supervisor {
    child: Arc<Mutex<Option<Child>>>,
}

fn node_bin() -> String {
    std::env::var("ZOME_NODE_PATH").unwrap_or_else(|_| "node".to_string())
}

/// 解析 node engine 入口（bootstrap.js）与其工作目录：
/// 1. `ZOME_ENGINE_ENTRY` 环境变量（部署时显式指定）
/// 2. sidecar 可执行文件附近的 engine/bootstrap.js（打包布局）
/// 3. 开发环境 monorepo 路径
/// 找不到时返回明确错误，而不是静默退回 cwd 再神秘超时。
fn engine_entry() -> anyhow::Result<(PathBuf, PathBuf)> {
    if let Ok(entry) = std::env::var("ZOME_ENGINE_ENTRY") {
        let entry = PathBuf::from(entry);
        if entry.exists() {
            let cwd = entry
                .parent()
                .map(|p| p.to_path_buf())
                .unwrap_or_else(|| PathBuf::from("."));
            return Ok((cwd, entry));
        }
        anyhow::bail!("ZOME_ENGINE_ENTRY points to a missing file: {}", entry.display());
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for candidate in [
                dir.join("engine").join("bootstrap.js"),
                dir.join("..").join("engine").join("bootstrap.js"),
                dir.join("resources").join("engine").join("bootstrap.js"),
            ] {
                if candidate.exists() {
                    let cwd = candidate
                        .parent()
                        .map(|p| p.to_path_buf())
                        .unwrap_or_else(|| PathBuf::from("."));
                    return Ok((cwd, candidate));
                }
            }
        }
    }
    let root = project_root()?;
    let dev = root.join("services/engine/dist/src/bootstrap.js");
    if dev.exists() {
        return Ok((root, dev));
    }
    anyhow::bail!(
        "node engine entry not found; set ZOME_ENGINE_ENTRY or place engine/bootstrap.js next to the sidecar binary"
    )
}

pub async fn spawn_node_engine() -> anyhow::Result<()> {
    if is_node_healthy().await {
        // 已有运行中的 engine（上次异常退出遗留）：直接复用，避免重复 spawn 导致端口冲突
        warn!("node engine already healthy; adopting existing process");
        return Ok(());
    }
    let (cwd, entry) = engine_entry()?;
    let mut cmd = Command::new(node_bin());
    cmd.arg(&entry).current_dir(&cwd);

    info!("spawning node engine: {:?}", cmd);
    let child = cmd.kill_on_drop(true).spawn()?;

    *SUPERVISOR.lock().await = Some(Supervisor {
        child: Arc::new(Mutex::new(Some(child))),
    });
    Ok(())
}

/// is_node_healthy 被 gRPC Health 高频调用（engine 侧最多每 10s 一次），
/// 复用单个 client 避免每次新建连接池。
static HEALTH_CLIENT: std::sync::LazyLock<reqwest::Client> = std::sync::LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .unwrap_or_default()
});

pub async fn is_node_healthy() -> bool {
    matches!(
        HEALTH_CLIENT.get(HEALTH_URL).send().await,
        Ok(resp) if resp.status().is_success()
    )
}

pub async fn watch_node_health() {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .unwrap_or_default();

    let deadline = tokio::time::Instant::now() + STARTUP_GRACE_PERIOD;
    let mut started = false;
    while tokio::time::Instant::now() < deadline {
        if check_health(&client).await {
            started = true;
            break;
        }
        tokio::time::sleep(STARTUP_CHECK_INTERVAL).await;
    }

    if !started {
        error!("node engine did not become healthy within startup grace period");
        return;
    }
    info!("node engine passed startup health check");

    let mut failures = 0u32;
    let mut restart_retries = 0u32;
    loop {
        tokio::time::sleep(HEALTH_CHECK_INTERVAL).await;

        if check_health(&client).await {
            failures = 0;
            restart_retries = 0;
            info!("node engine health ok");
            continue;
        }

        failures += 1;
        warn!(
            "node engine health check failed ({}/{})",
            failures, UNHEALTHY_FAILURE_THRESHOLD
        );

        if failures < UNHEALTHY_FAILURE_THRESHOLD {
            continue;
        }

        if restart_retries >= MAX_RESTART_RETRIES {
            error!("node engine restart retries exceeded; giving up to avoid restart storm");
            break;
        }

        let backoff = Duration::from_secs(2u64.pow(restart_retries));
        error!(
            "node engine unhealthy; restarting after {:?} backoff (attempt {}/{})",
            backoff,
            restart_retries + 1,
            MAX_RESTART_RETRIES
        );
        tokio::time::sleep(backoff).await;
        restart().await;
        restart_retries += 1;
        failures = 0;
    }
}

async fn check_health(client: &reqwest::Client) -> bool {
    match client.get(HEALTH_URL).send().await {
        Ok(resp) if resp.status().is_success() => true,
        Ok(resp) => {
            warn!("node engine health returned {}", resp.status());
            false
        }
        Err(e) => {
            warn!("node engine health check failed: {}", e);
            false
        }
    }
}

pub async fn shutdown() {
    let sup = {
        let guard = SUPERVISOR.lock().await;
        guard.clone()
    };
    if let Some(sup) = sup {
        sup.shutdown().await;
    }
}

async fn restart() {
    let sup = {
        let guard = SUPERVISOR.lock().await;
        guard.clone()
    };
    if let Some(sup) = sup {
        sup.restart().await;
    }
}

impl Supervisor {
    async fn restart(&self) {
        self.shutdown().await;

        let (cwd, entry) = match engine_entry() {
            Ok(v) => v,
            Err(e) => {
                error!("cannot restart node engine: {e}");
                return;
            }
        };
        let mut cmd = Command::new(node_bin());
        cmd.arg(&entry).current_dir(&cwd);

        match cmd.kill_on_drop(true).spawn() {
            Ok(child) => {
                *self.child.lock().await = Some(child);
                info!("node engine restarted");
            }
            Err(e) => error!("failed to restart node engine: {}", e),
        }
    }

    pub async fn shutdown(&self) {
        let child = {
            let mut guard = self.child.lock().await;
            guard.take()
        };
        if let Some(mut child) = child {
            #[cfg(windows)]
            {
                if let Some(id) = child.id() {
                    Command::new("taskkill")
                        .args(["/PID", &id.to_string(), "/T"])
                        .output()
                        .await
                        .ok();

                    let mut waited = 0u32;
                    while waited < 3000 {
                        tokio::time::sleep(Duration::from_millis(200)).await;
                        waited += 200;
                        if child.try_wait().unwrap_or(None).is_some() {
                            break;
                        }
                    }

                    if child.try_wait().unwrap_or(None).is_none() {
                        Command::new("taskkill")
                            .args(["/PID", &id.to_string(), "/T", "/F"])
                            .output()
                            .await
                            .ok();
                    }
                }
            }
            #[cfg(not(windows))]
            {
                child.start_kill().ok();
            }

            child.wait().await.ok();
            info!("node engine stopped");
        }
    }
}
