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

pub struct Supervisor {
    child: Arc<Mutex<Option<Child>>>,
}

pub async fn spawn_node_engine() -> anyhow::Result<()> {
    let mut cmd = Command::new("node");
    cmd.arg("services/engine/dist/src/bootstrap.js")
        .current_dir(project_root()?);

    info!("spawning node engine: {:?}", cmd);
    let child = cmd.kill_on_drop(true).spawn()?;

    *SUPERVISOR.lock().await = Some(Supervisor {
        child: Arc::new(Mutex::new(Some(child))),
    });
    Ok(())
}

pub async fn is_node_healthy() -> bool {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .unwrap_or_default();
    matches!(
        client.get(HEALTH_URL).send().await,
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
    if let Some(sup) = SUPERVISOR.lock().await.as_ref() {
        sup.shutdown().await;
    }
}

async fn restart() {
    if let Some(sup) = SUPERVISOR.lock().await.as_ref() {
        sup.restart().await;
    }
}

impl Supervisor {
    async fn restart(&self) {
        self.shutdown().await;

        let mut cmd = Command::new("node");
        cmd.arg("services/engine/dist/src/bootstrap.js")
            .current_dir(project_root().unwrap_or_else(|_| "./".into()));

        match cmd.kill_on_drop(true).spawn() {
            Ok(child) => {
                *self.child.lock().await = Some(child);
                info!("node engine restarted");
            }
            Err(e) => error!("failed to restart node engine: {}", e),
        }
    }

    pub async fn shutdown(&self) {
        if let Some(mut child) = self.child.lock().await.take() {
            #[cfg(windows)]
            {
                if let Some(id) = child.id() {
                    let _ = Command::new("taskkill")
                        .args(["/PID", &id.to_string(), "/T"])
                        .output()
                        .await;

                    let mut waited = 0u32;
                    while waited < 3000 {
                        tokio::time::sleep(Duration::from_millis(200)).await;
                        waited += 200;
                        if child.try_wait().unwrap_or(None).is_some() {
                            break;
                        }
                    }

                    if child.try_wait().unwrap_or(None).is_none() {
                        let _ = Command::new("taskkill")
                            .args(["/PID", &id.to_string(), "/T", "/F"])
                            .output()
                            .await;
                    }
                }
            }
            #[cfg(not(windows))]
            {
                let _ = child.start_kill();
            }

            let _ = child.wait().await;
            info!("node engine stopped");
        }
    }
}
