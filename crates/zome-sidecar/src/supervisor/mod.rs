use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tracing::{error, info, warn};

use crate::data_dir;
use crate::project_root;

// engine 默认地址的权威定义在 packages/shared/src/constants.ts（DEFAULT_ENGINE_URL，P5-2）；
// Rust 无法消费 TS 包，此处硬编码需与其人工对齐
const HEALTH_URL: &str = "http://127.0.0.1:8848/health";
const HEALTH_CHECK_INTERVAL: Duration = Duration::from_secs(5);
const STARTUP_GRACE_PERIOD: Duration = Duration::from_secs(30);
const STARTUP_CHECK_INTERVAL: Duration = Duration::from_secs(1);
const UNHEALTHY_FAILURE_THRESHOLD: u32 = 3;
const MAX_RESTART_RETRIES: u32 = 5;
/// 启动宽限失败 / 快速重启用尽 / 端口冲突后的低频监控重试间隔：
/// 永不放弃恢复闭环，但避免重启风暴
const DEGRADED_MONITOR_INTERVAL: Duration = Duration::from_secs(30);
/// engine listen 失败对 EADDRINUSE 约定的 exit code（见 services/engine 的 listen-error.ts）
const EADDRINUSE_EXIT_CODE: i32 = 2;

static SUPERVISOR: std::sync::LazyLock<Mutex<Option<Supervisor>>> =
    std::sync::LazyLock::new(|| Mutex::new(None));

#[derive(Clone)]
pub struct Supervisor {
    child: Arc<Mutex<Option<Child>>>,
    /// 收编 engine 的 pid（H9，来自数据目录 engine.pid）：child=None 时凭它
    /// 在校验进程身份后击杀收编进程，闭合 restart/shutdown 恢复闭环；
    /// pidfile 缺失/损坏为 None（维持旧语义：只监控不击杀）。
    /// 击杀或确认已死后取走置 None，同一 pid 绝不触碰第二次（pid 复用防护）
    adopted_pid: Arc<Mutex<Option<u32>>>,
}

fn node_bin() -> String {
    if let Ok(p) = std::env::var("ZOME_NODE_PATH") {
        return p;
    }
    // 打包布局：优先随包分发的内嵌 Node（P0-4，用户机器零依赖）；
    // resources 在 Windows/NSIS 与 unix 安装布局下分别落在 exe 旁或 resources/ 子目录
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let name = if cfg!(windows) { "node.exe" } else { "node" };
            for candidate in [
                dir.join("node").join(name),
                dir.join("resources").join("node").join(name),
            ] {
                if candidate.exists() {
                    return candidate.to_string_lossy().into_owned();
                }
            }
        }
    }
    "node".to_string()
}

/// 解析 node engine 入口（bootstrap.js）与其工作目录：
/// 1. `ZOME_ENGINE_ENTRY` 环境变量（部署时显式指定）
/// 2. sidecar 可执行文件附近的 engine/bootstrap.js（打包布局）
/// 3. 开发环境 monorepo 路径
///
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
        anyhow::bail!(
            "ZOME_ENGINE_ENTRY points to a missing file: {}",
            entry.display()
        );
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

/// 构造 engine spawn 命令（P1-3 数据目录统一）：sidecar 解析出的数据目录是
/// 唯一权威源，显式注入 CLOUDMIND_DATA_DIR，保证 engine/sidecar 同一棵树。
/// 独立 dev 模式（engine 不经 sidecar 启动）不受此影响，仍用 engine 自己的默认。
fn engine_command(cwd: &Path, entry: &Path) -> Command {
    let mut cmd = Command::new(node_bin());
    cmd.arg(entry)
        .current_dir(cwd)
        .env("CLOUDMIND_DATA_DIR", data_dir());
    cmd
}

pub async fn spawn_node_engine() -> anyhow::Result<()> {
    if is_node_healthy().await {
        // 已有运行中的 engine（上次异常退出遗留）：直接复用，避免重复 spawn 导致端口冲突。
        // 收编同样注册进 SUPERVISOR 纳入监控，并记录 engine.pid 中的 pid（H9）：
        // 收编进程挂死后 restart/shutdown 校验身份再击杀，恢复闭环不再断裂；
        // pidfile 缺失/损坏则 adopted_pid=None，维持旧语义（只监控不击杀）。
        warn!("node engine already healthy; adopting existing process");
        *SUPERVISOR.lock().await = Some(Supervisor {
            child: Arc::new(Mutex::new(None)),
            adopted_pid: Arc::new(Mutex::new(read_engine_pid())),
        });
        return Ok(());
    }
    let spawned: anyhow::Result<Child> = (|| {
        let (cwd, entry) = engine_entry()?;
        let mut cmd = engine_command(&cwd, &entry);
        info!("spawning node engine: {:?}", cmd);
        Ok(cmd.kill_on_drop(true).spawn()?)
    })();
    match spawned {
        Ok(child) => {
            *SUPERVISOR.lock().await = Some(Supervisor {
                child: Arc::new(Mutex::new(Some(child))),
                adopted_pid: Arc::new(Mutex::new(None)),
            });
            Ok(())
        }
        Err(e) => {
            // H10a：注册空 Supervisor 再返回 Err——main 记档后不退出，
            // watch_node_health 的 restart 必须拿到 Supervisor 句柄才能
            // 低频重试拉起（如 engine 入口稍后构建完成才就位）
            *SUPERVISOR.lock().await = Some(Supervisor {
                child: Arc::new(Mutex::new(None)),
                adopted_pid: Arc::new(Mutex::new(None)),
            });
            Err(e)
        }
    }
}

/// engine.pid 内容解析（纯函数，供单测）：合法内容为单个十进制 pid
fn parse_pid_file(content: &str) -> Option<u32> {
    content.trim().parse::<u32>().ok().filter(|pid| *pid > 0)
}

/// 读数据目录 engine.pid（H9）：收编的 engine 不是我们 spawn 的 child，
/// 只有凭 pidfile 才能在 restart/shutdown 时击杀它、闭合恢复闭环。
/// 缺失/损坏按无 pid 处理（记 warn，维持只监控不击杀的旧语义）
fn read_engine_pid() -> Option<u32> {
    let path = data_dir().join("engine.pid");
    match std::fs::read_to_string(&path) {
        Ok(content) => {
            let pid = parse_pid_file(&content);
            if pid.is_none() {
                warn!("engine.pid 内容损坏（{}）：按无 pid 处理", path.display());
            }
            pid
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            warn!(
                "engine.pid 缺失（{}）：收编的 engine 将无法被击杀",
                path.display()
            );
            None
        }
        Err(e) => {
            warn!(
                "engine.pid 读取失败（{}: {}）：按无 pid 处理",
                path.display(),
                e
            );
            None
        }
    }
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

    if started {
        info!("node engine passed startup health check");
    } else {
        // 不放弃监控（D-B1）：转入低频持续监控，engine 之后任何时刻恢复都会被感知
        error!(
            "node engine did not become healthy within {:?}; keep monitoring every {:?}",
            STARTUP_GRACE_PERIOD, DEGRADED_MONITOR_INTERVAL
        );
    }

    let mut failures = 0u32;
    let mut restart_retries = 0u32;
    let mut port_conflict = false;
    loop {
        let degraded = !started || port_conflict || restart_retries >= MAX_RESTART_RETRIES;
        tokio::time::sleep(if degraded {
            DEGRADED_MONITOR_INTERVAL
        } else {
            HEALTH_CHECK_INTERVAL
        })
        .await;

        if check_health(&client).await {
            if !started || port_conflict || restart_retries > 0 {
                info!("node engine healthy again; supervisor recovered to normal monitoring");
            }
            started = true;
            port_conflict = false;
            failures = 0;
            restart_retries = 0;
            continue;
        }

        // EADDRINUSE（D-M4）：engine 以 exit 2 退出且 /health 不通 = 8848 被其他进程占用。
        // 高频重启只会反复 exit 2：降级为低频重试等端口释放，并给出明确提示
        if child_exit_code().await == Some(EADDRINUSE_EXIT_CODE) {
            if !port_conflict {
                error!(
                    "node engine exited with code {} (EADDRINUSE): 8848 被其他进程占用且 /health 不通；转为每 {:?} 低频重试，请检查端口冲突",
                    EADDRINUSE_EXIT_CODE, DEGRADED_MONITOR_INTERVAL
                );
            }
            port_conflict = true;
            restart().await;
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
            // 永不放弃（D-B1）：快速重启用尽后不再 break，转为低频持续重试
            error!(
                "node engine still unhealthy after {} restarts; keep retrying every {:?}",
                MAX_RESTART_RETRIES, DEGRADED_MONITOR_INTERVAL
            );
            restart().await;
            failures = 0;
            continue;
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

/// 当前纳管 child 的退出码；仍在运行、无 child（收编）或读取失败均为 None
async fn child_exit_code() -> Option<i32> {
    let sup = SUPERVISOR.lock().await.clone()?;
    let mut guard = sup.child.lock().await;
    let child = guard.as_mut()?;
    match child.try_wait() {
        Ok(Some(status)) => status.code(),
        _ => None,
    }
}

/// 测试与状态上报用：是否已有纳管的 engine（spawn 或收编）
pub async fn has_supervised_engine() -> bool {
    SUPERVISOR.lock().await.is_some()
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
    // 取走并清空注册：shutdown 后不再纳管任何 engine
    let sup = {
        let mut guard = SUPERVISOR.lock().await;
        guard.take()
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

/// 收编进程的核验状态（H9）：击杀前必须先确认"是这个进程、且确实是 engine"，
/// 防 pid 复用误杀无关进程
#[derive(Debug, PartialEq, Eq)]
enum AdoptedProcState {
    /// 进程存活且身份确认为 node engine（cmdline 含 bootstrap.js / 映像 node.exe）
    Engine,
    /// 进程存活但身份不符（疑似 pid 复用）——只记 warn，绝不杀
    Stranger,
    /// 进程已退出（含僵尸/无命令行），或查询失败无从校验——不杀
    Gone,
}

/// /proc/<pid>/cmdline（NUL 分隔）是否指向 node engine 入口 bootstrap.js
/// （纯函数，供单测）
#[cfg(all(unix, any(target_os = "linux", test)))]
fn cmdline_is_bootstrap_engine(cmdline: &[u8]) -> bool {
    String::from_utf8_lossy(cmdline)
        .split('\0')
        .any(|arg| arg.contains("bootstrap.js"))
}

#[cfg(target_os = "linux")]
async fn adopted_proc_state(pid: u32) -> AdoptedProcState {
    // /proc 直连是 Linux 优先路径（不起子进程）。僵尸进程 cmdline 为空，
    // 等同已死；读不到（进程已退出/权限）无从校验 → Gone 绝不杀
    match std::fs::read(format!("/proc/{pid}/cmdline")) {
        Ok(cmdline) if cmdline.is_empty() => AdoptedProcState::Gone,
        Ok(cmdline) => {
            if cmdline_is_bootstrap_engine(&cmdline) {
                AdoptedProcState::Engine
            } else {
                AdoptedProcState::Stranger
            }
        }
        Err(_) => AdoptedProcState::Gone,
    }
}

/// 无 /proc 平台（macOS 等 unix）的收编进程核验：ps -p <pid> -o args= 读
/// 命令行，与 /proc 路径同一判定（argv 含 bootstrap.js）。任何校验不到的
/// 形态（进程不存在/ps 失败）都按 Gone 安全退化——绝不误杀
#[cfg(all(unix, not(target_os = "linux")))]
async fn adopted_proc_state(pid: u32) -> AdoptedProcState {
    adopted_proc_state_ps(pid).await
}

/// ps 核验实现（独立成函数：Linux 测试可直接对真进程实测该路径——procps
/// 与 macOS BSD ps 的 -o args= 输出形态一致，见 parse_ps_args_state 注释）
#[cfg(all(unix, any(not(target_os = "linux"), test)))]
async fn adopted_proc_state_ps(pid: u32) -> AdoptedProcState {
    match Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "args="])
        .output()
        .await
    {
        // 进程不存在：ps 无输出且退出码非零 → Gone
        Ok(o) if !o.status.success() => AdoptedProcState::Gone,
        Ok(o) => parse_ps_args_state(&String::from_utf8_lossy(&o.stdout)),
        // ps 调用失败无从校验：不杀
        Err(_) => AdoptedProcState::Gone,
    }
}

/// ps -p <pid> -o args= 输出解析（纯函数，供单测）：-o args= 的空列名压掉
/// 表头，输出即完整 argv 的空格拼接单行。与 /proc 路径同判定：任一空格
/// 切分 token 含 bootstrap.js → Engine，否则 Stranger；空白输出 → Gone。
/// token 切分与 /proc 的 per-arg contains 判定证据门槛相同（含空格的路径
/// 如 "Application Support/.../bootstrap.js" 末段 token 仍命中），不改变
/// 判定方向。
///
/// 平台差异（Linux procps 实测，macOS 为 BSD ps 文档口径）：
/// 两者对 -p/-o args= 的输出形态一致（无表头单行命令行）；差别在僵尸——
/// Linux 输出 "[cmd] <defunct>"（判 Stranger，安全退化不杀，kill 等待
/// 循环视其为已退出），macOS 僵尸 args 为空（判 Gone）；进程不存在时
/// 两者均无输出且退出码非零（调用方先按退出码判 Gone）
#[cfg(all(unix, any(not(target_os = "linux"), test)))]
fn parse_ps_args_state(output: &str) -> AdoptedProcState {
    let args = output.trim();
    if args.is_empty() {
        return AdoptedProcState::Gone;
    }
    if args
        .split_whitespace()
        .any(|arg| arg.contains("bootstrap.js"))
    {
        AdoptedProcState::Engine
    } else {
        AdoptedProcState::Stranger
    }
}

/// tasklist /FO CSV /NH 输出解析（纯函数，供单测）：
/// 有该 pid 行且映像为 node.exe → Engine；有该 pid 行但映像不符 → Stranger；
/// 无匹配行（含 "INFO: No tasks ..." 提示）→ Gone
#[cfg(any(windows, test))]
fn parse_tasklist_state(output: &str, pid: u32) -> AdoptedProcState {
    let pid = pid.to_string();
    for line in output.lines() {
        let mut fields = line.split(',');
        let image = fields.next().unwrap_or("").trim_matches('"');
        let field_pid = fields.next().unwrap_or("").trim_matches('"');
        if field_pid != pid {
            continue;
        }
        return if image.eq_ignore_ascii_case("node.exe") {
            AdoptedProcState::Engine
        } else {
            AdoptedProcState::Stranger
        };
    }
    AdoptedProcState::Gone
}

#[cfg(windows)]
async fn adopted_proc_state(pid: u32) -> AdoptedProcState {
    match Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
        .output()
        .await
    {
        Ok(o) => parse_tasklist_state(&String::from_utf8_lossy(&o.stdout), pid),
        // 查询失败无从校验：不杀
        Err(_) => AdoptedProcState::Gone,
    }
}

/// 温和终止（Unix SIGTERM / Windows taskkill /T）
#[cfg(unix)]
async fn terminate_pid(pid: u32) {
    Command::new("kill")
        .arg(pid.to_string())
        .output()
        .await
        .ok();
}

#[cfg(windows)]
async fn terminate_pid(pid: u32) {
    Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T"])
        .output()
        .await
        .ok();
}

/// 强杀升级（Unix SIGKILL / Windows taskkill /F）
#[cfg(unix)]
async fn force_kill_pid(pid: u32) {
    Command::new("kill")
        .args(["-9", &pid.to_string()])
        .output()
        .await
        .ok();
}

#[cfg(windows)]
async fn force_kill_pid(pid: u32) {
    Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .output()
        .await
        .ok();
}

/// 击杀收编的 engine（H9：child=None 时恢复闭环的关键，此前 shutdown 对
/// 收编进程是空操作，收编 engine 挂死占住 8848 后 restart 永远 port_conflict）。
///
/// 先校验进程身份（防 pid 复用误杀）：Linux 读 /proc/<pid>/cmdline，
/// macOS 等无 /proc unix 用 ps -p <pid> -o args=，均须含 bootstrap.js；
/// Windows 用 tasklist 校验映像名 node.exe。校验不过或进程已死只记日志
/// 绝不杀。两段式终止：先温和终止，3s 未退升级强杀（与现有 Windows child
/// 路径 taskkill /T → /F 同构）。
///
/// 进程交互部分无法单测的部分（真实信号投递/等待语义）需手工验证：
/// 桌面端启动后 kill -9 sidecar 再重启（触发收编），随后 kill -STOP engine
/// 制造假死，观察 supervisor 先 SIGTERM 后 SIGKILL 并重新拉起 engine。
async fn kill_adopted_engine(pid: u32) {
    match adopted_proc_state(pid).await {
        AdoptedProcState::Gone => {
            info!("adopted engine pid {} already exited; nothing to kill", pid);
            return;
        }
        AdoptedProcState::Stranger => {
            warn!(
                "adopted engine pid {} failed identity check (not node bootstrap.js; pid likely reused): refusing to kill",
                pid
            );
            return;
        }
        AdoptedProcState::Engine => {}
    }

    terminate_pid(pid).await;

    // 等待退出（与 child 路径同款 3s 轮询）；等待窗口内 pid 被复用成无关
    // 进程时状态不再是 Engine，强杀升级自然被挡下
    let mut waited = 0u32;
    while waited < 3000 {
        tokio::time::sleep(Duration::from_millis(200)).await;
        waited += 200;
        if adopted_proc_state(pid).await != AdoptedProcState::Engine {
            info!("adopted node engine (pid {}) stopped", pid);
            return;
        }
    }

    if adopted_proc_state(pid).await == AdoptedProcState::Engine {
        warn!(
            "adopted engine pid {} ignored graceful termination; force killing",
            pid
        );
        force_kill_pid(pid).await;
        info!("adopted node engine (pid {}) force killed", pid);
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
        let mut cmd = engine_command(&cwd, &entry);

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
            return;
        }
        // H9：收编路径（child=None）凭 pidfile 记录的 pid 击杀——此前这里是
        // 空操作，收编 engine 挂死占住 8848 后 restart 永远撞 port_conflict，
        // 恢复闭环断裂。取走即清空：同一 pid 绝不重复触碰（pid 复用防护）
        let adopted_pid = {
            let mut guard = self.adopted_pid.lock().await;
            guard.take()
        };
        if let Some(pid) = adopted_pid {
            kill_adopted_engine(pid).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// P1-3 数据目录统一：spawn 链路必须把 sidecar 解析出的数据目录
    /// 显式注入 engine（CLOUDMIND_DATA_DIR），保证 engine/sidecar 同一棵树
    #[test]
    fn engine_command_injects_unified_data_dir() {
        let cmd = engine_command(Path::new("/tmp/x"), Path::new("/tmp/x/bootstrap.js"));
        let value = cmd
            .as_std()
            .get_envs()
            .find(|(k, _)| *k == "CLOUDMIND_DATA_DIR")
            .and_then(|(_, v)| v);
        assert_eq!(
            value,
            Some(data_dir().as_os_str()),
            "CLOUDMIND_DATA_DIR must be injected with sidecar's resolved data_dir"
        );
    }

    #[test]
    fn parse_pid_file_accepts_only_decimal_pid() {
        assert_eq!(parse_pid_file("12345"), Some(12345));
        assert_eq!(parse_pid_file("  42\n"), Some(42));
        assert_eq!(parse_pid_file(""), None);
        assert_eq!(parse_pid_file("abc"), None);
        assert_eq!(parse_pid_file("0"), None);
        assert_eq!(parse_pid_file("-1"), None);
        assert_eq!(parse_pid_file("12 34"), None);
    }

    /// H9：pidfile 缺失/损坏按无 pid 处理，合法内容解析出 pid
    #[test]
    fn read_engine_pid_missing_corrupt_then_valid() {
        let tmp =
            std::env::temp_dir().join(format!("zome-sidecar-pidfile-test-{}", std::process::id()));
        std::fs::remove_dir_all(&tmp).ok();
        std::fs::create_dir_all(&tmp).unwrap();
        crate::set_data_dir_override(&tmp);

        assert_eq!(read_engine_pid(), None, "缺失 → 无 pid");
        std::fs::write(tmp.join("engine.pid"), "not-a-pid").unwrap();
        assert_eq!(read_engine_pid(), None, "损坏 → 无 pid");
        std::fs::write(tmp.join("engine.pid"), "12345\n").unwrap();
        assert_eq!(read_engine_pid(), Some(12345));

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[cfg(unix)]
    #[test]
    fn cmdline_identity_check() {
        assert!(cmdline_is_bootstrap_engine(
            b"node\0/opt/engine/bootstrap.js\0"
        ));
        assert!(cmdline_is_bootstrap_engine(
            b"/usr/bin/node\0bootstrap.js\0"
        ));
        assert!(!cmdline_is_bootstrap_engine(b"sleep\x0030\0"));
        assert!(!cmdline_is_bootstrap_engine(b""));
        assert!(!cmdline_is_bootstrap_engine(b"node\0server.js\0"));
    }

    #[test]
    fn tasklist_state_parse() {
        let node = "\"node.exe\",\"1234\",\"Console\",\"1\",\"50,000 K\"\r\n";
        assert_eq!(parse_tasklist_state(node, 1234), AdoptedProcState::Engine);
        // 映像名大小写不敏感
        let upper = "\"NODE.EXE\",\"1234\",\"Console\",\"1\",\"50,000 K\"";
        assert_eq!(parse_tasklist_state(upper, 1234), AdoptedProcState::Engine);
        let chrome = "\"chrome.exe\",\"1234\",\"Console\",\"1\",\"50,000 K\"\r\n";
        assert_eq!(
            parse_tasklist_state(chrome, 1234),
            AdoptedProcState::Stranger
        );
        assert_eq!(
            parse_tasklist_state(
                "INFO: No tasks are running which match the specified criteria.",
                1234
            ),
            AdoptedProcState::Gone
        );
    }

    /// H9（D4 macOS 收编核验）：ps -p <pid> -o args= 输出解析——fixture 为
    /// 真实输出形态：macOS 行取自 BSD ps 文档口径（-o args= 无表头单行完整
    /// 命令行），Linux 行为本机 procps 实测；两平台的格式差异（僵尸输出
    /// "[cmd] <defunct>" vs 空）见 parse_ps_args_state 注释
    #[cfg(unix)]
    #[test]
    fn ps_args_state_parse() {
        // macOS 形态：内嵌/用户态 node + 含空格路径（末段 token 仍命中）
        let macos = "/Users/jane/.nvm/versions/node/v22.11.0/bin/node \
             /Users/jane/Library/Application Support/cloudmind-zome/engine/bootstrap.js";
        assert_eq!(parse_ps_args_state(macos), AdoptedProcState::Engine);
        // Linux 形态：exec -a 伪装 argv0（本文件真进程 harness 实测输出）
        assert_eq!(
            parse_ps_args_state("node /tmp/bootstrap.js 30"),
            AdoptedProcState::Engine
        );
        assert_eq!(
            parse_ps_args_state("node services/engine/dist/src/bootstrap.js"),
            AdoptedProcState::Engine
        );
        // 无关进程（疑似 pid 复用）→ Stranger，绝不杀
        assert_eq!(parse_ps_args_state("sleep 30"), AdoptedProcState::Stranger);
        // Linux 僵尸实测形态 → Stranger（安全退化不杀，kill 等待循环视为已退出）
        assert_eq!(
            parse_ps_args_state("[sleep] <defunct>"),
            AdoptedProcState::Stranger
        );
        // 空白输出（macOS 僵尸/异常形态）→ Gone
        assert_eq!(parse_ps_args_state(""), AdoptedProcState::Gone);
        assert_eq!(parse_ps_args_state("  \n"), AdoptedProcState::Gone);
    }

    /// 造一个 cmdline 含 bootstrap.js 的活进程（exec -a 伪装 argv0），
    /// 供身份校验通过后的真实击杀路径测试
    #[cfg(target_os = "linux")]
    fn spawn_fake_engine() -> std::process::Child {
        std::process::Command::new("bash")
            .args(["-c", "exec -a 'node /tmp/bootstrap.js' sleep 30"])
            .spawn()
            .expect("spawn fake engine")
    }

    /// spawn 返回（fork）到 exec 完成之间有窗口期：/proc/<pid>/cmdline
    /// 短暂为空，直接读会误判 Gone。轮询等它就绪
    #[cfg(target_os = "linux")]
    async fn wait_cmdline_ready(pid: u32) {
        for _ in 0..100 {
            let ready = std::fs::read(format!("/proc/{pid}/cmdline"))
                .map(|c| !c.is_empty())
                .unwrap_or(false);
            if ready {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("process {pid} cmdline not visible in /proc");
    }

    /// 断言失败后兜底清理，不留 sleep 30 孤儿
    #[cfg(target_os = "linux")]
    fn cleanup_proc(proc: &mut std::process::Child) {
        std::process::Command::new("kill")
            .args(["-9", &proc.id().to_string()])
            .output()
            .ok();
        proc.wait().ok();
    }

    /// H9：身份校验通过的收编进程会被击杀（SIGTERM 即死，无需升级 SIGKILL）
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn kill_adopted_engine_kills_verified_engine() {
        let mut proc = spawn_fake_engine();
        let pid = proc.id();
        wait_cmdline_ready(pid).await;
        // 前置断言：伪装生效，身份校验确实通过
        assert_eq!(adopted_proc_state(pid).await, AdoptedProcState::Engine);

        kill_adopted_engine(pid).await;
        let state = adopted_proc_state(pid).await;
        cleanup_proc(&mut proc);
        // 已死（僵尸 cmdline 为空，按 Gone 处理）
        assert_eq!(state, AdoptedProcState::Gone);
    }

    /// H9：身份不符（pid 复用成无关进程）只记 warn 绝不杀
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn kill_adopted_engine_refuses_stranger() {
        let mut proc = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .expect("spawn stranger");
        let pid = proc.id();
        wait_cmdline_ready(pid).await;
        // 前置断言：确实是无关进程
        assert_eq!(adopted_proc_state(pid).await, AdoptedProcState::Stranger);

        kill_adopted_engine(pid).await;
        let state = adopted_proc_state(pid).await;
        cleanup_proc(&mut proc);
        assert_eq!(
            state,
            AdoptedProcState::Stranger,
            "stranger must NOT be killed"
        );
    }

    /// H9：pid 已死是快速 no-op（若退化成盲杀+3s 轮询，此断言会因超时暴露）
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn kill_adopted_engine_dead_pid_noop() {
        let mut proc = std::process::Command::new("true")
            .spawn()
            .expect("spawn true");
        proc.wait().ok();
        let pid = proc.id();
        tokio::time::timeout(Duration::from_secs(5), kill_adopted_engine(pid))
            .await
            .expect("dead pid must be a fast no-op");
    }

    /// H9：Supervisor::shutdown 在 child=None 时凭 adopted_pid 击杀收编进程，
    /// 且 pid 取走后重复 shutdown 是 no-op
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn shutdown_kills_adopted_engine_once() {
        let mut proc = spawn_fake_engine();
        let pid = proc.id();
        wait_cmdline_ready(pid).await;
        let sup = Supervisor {
            child: Arc::new(Mutex::new(None)),
            adopted_pid: Arc::new(Mutex::new(Some(pid))),
        };
        sup.shutdown().await;
        let state = adopted_proc_state(pid).await;
        sup.shutdown().await; // adopted_pid 已取走：no-op，不 panic 不挂起
        cleanup_proc(&mut proc);
        assert_eq!(state, AdoptedProcState::Gone);
    }

    /// H9（D4）：macOS 收编核验走的 ps 路径在 Linux 上对真进程实测——
    /// 伪装 engine 判 Engine（与 /proc 路径判定一致）、无关进程判 Stranger、
    /// 已死 pid 判 Gone（ps 无输出且退出码非零）。procps 与 macOS BSD ps 的
    /// -o args= 输出形态一致（差异见 parse_ps_args_state 注释）；真实 macOS
    /// 上的杀/拒杀行为沿用批次 3 的手工验证口径
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn ps_path_state_matches_proc_on_real_processes() {
        // 伪装 engine：ps 与 /proc 两条核验路径判定必须一致
        let mut engine = spawn_fake_engine();
        let pid = engine.id();
        wait_cmdline_ready(pid).await;
        assert_eq!(adopted_proc_state_ps(pid).await, AdoptedProcState::Engine);
        assert_eq!(adopted_proc_state(pid).await, AdoptedProcState::Engine);
        cleanup_proc(&mut engine);
        // 击杀+回收后 pid 不存在：ps 退出码非零 → Gone
        assert_eq!(adopted_proc_state_ps(pid).await, AdoptedProcState::Gone);

        // 无关进程：Stranger（两路径一致），绝不杀的安全退化成立
        let mut stranger = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .expect("spawn stranger");
        let spid = stranger.id();
        wait_cmdline_ready(spid).await;
        assert_eq!(
            adopted_proc_state_ps(spid).await,
            AdoptedProcState::Stranger
        );
        cleanup_proc(&mut stranger);

        // 已死 pid：ps 无输出且退出码非零 → Gone
        let mut dead = std::process::Command::new("true")
            .spawn()
            .expect("spawn true");
        dead.wait().ok();
        assert_eq!(
            adopted_proc_state_ps(dead.id()).await,
            AdoptedProcState::Gone
        );
    }
}
