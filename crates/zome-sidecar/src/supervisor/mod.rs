use std::sync::Arc;
use std::time::Duration;

use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tracing::{error, info, warn};

use crate::project_root;

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

pub async fn watch_node_health() {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .unwrap_or_default();
    let mut failures = 0u32;

    loop {
        tokio::time::sleep(Duration::from_secs(5)).await;

        match client.get("http://127.0.0.1:8848/health").send().await {
            Ok(resp) if resp.status().is_success() => {
                failures = 0;
                info!("node engine health ok");
            }
            Ok(resp) => {
                warn!("node engine health returned {}", resp.status());
                failures += 1;
            }
            Err(e) => {
                warn!("node engine health check failed: {}", e);
                failures += 1;
            }
        }

        if failures >= 3 {
            error!("node engine unhealthy, restarting");
            restart().await;
            failures = 0;
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
