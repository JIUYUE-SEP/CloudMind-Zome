import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_SIDECAR_ADDR } from "@cloudmind/shared";
import { logger } from "../logger.js";
import { getDataDir } from "../config/paths.js";
import type { ConfigRepository } from "../config/repository.js";
import type { SidecarClient } from "./client.js";

/** 纳用探活短超时（spec 决策 2：200ms——主启动不被慢探活拖住） */
const ADOPT_PROBE_MS = 200;
/** 关停两段式：SIGTERM 后超时升级 SIGKILL（spec 决策 5，照 MCP 关停纪律） */
const SIGKILL_AFTER_MS = 5_000;

export interface SidecarBin {
  command: string;
  args: string[];
  /** 日志展示用的来源描述 */
  display: string;
}

export interface AutostartDeps {
  configRepository: ConfigRepository;
  /** 纳用探活 client（生产 = root.sidecar 同实例；测试注入假 client） */
  sidecarClient?: Pick<SidecarClient, "isAvailable">;
  /** 以下为可测性注入点（生产全缺省） */
  spawnFn?: typeof spawn;
  existsFn?: (p: string) => Promise<boolean>;
  envBin?: string | undefined;
  pathEnv?: string;
  /** 仓内二进制/Cargo.toml 探测基准目录（生产 = process.cwd() 上探） */
  repoDir?: string;
}

async function defaultExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function winExe(name: string): string {
  return process.platform === "win32" ? `${name}.exe` : name;
}

async function findOnPath(name: string, pathEnv: string, exists: (p: string) => Promise<boolean>): Promise<string | undefined> {
  const delimiter = process.platform === "win32" ? ";" : ":";
  const candidates = process.platform === "win32" ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name] : [name];
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const candidate of candidates) {
      const full = path.join(dir, candidate);
      if (await exists(full)) return full;
    }
  }
  return undefined;
}

/**
 * 二进制发现序（spec 决策 3）：`ZOME_SIDECAR_BIN` 环境变量 → 仓内 release →
 * 仓内 debug → PATH `zome-sidecar` → `cargo run` 兜底；全灭返回 undefined
 * （调用方 warn 降级，不炸 engine）。
 */
export async function resolveSidecarBin(deps: Pick<AutostartDeps, "existsFn" | "envBin" | "pathEnv" | "repoDir">): Promise<SidecarBin | undefined> {
  const exists = deps.existsFn ?? defaultExists;
  const envBin = deps.envBin !== undefined ? deps.envBin : process.env.ZOME_SIDECAR_BIN;
  const pathEnv = deps.pathEnv ?? process.env.PATH ?? "";
  const repoDir = deps.repoDir ?? process.cwd();

  if (envBin && (await exists(envBin))) {
    return { command: envBin, args: [], display: `ZOME_SIDECAR_BIN=${envBin}` };
  }
  const release = path.join(repoDir, "crates", "zome-sidecar", "target", "release", winExe("zome-sidecar"));
  if (await exists(release)) {
    return { command: release, args: [], display: `仓内 release 二进制（${release}）` };
  }
  const debug = path.join(repoDir, "crates", "zome-sidecar", "target", "debug", winExe("zome-sidecar"));
  if (await exists(debug)) {
    return { command: debug, args: [], display: `仓内 debug 二进制（${debug}）` };
  }
  const onPath = await findOnPath("zome-sidecar", pathEnv, exists);
  if (onPath) {
    return { command: onPath, args: [], display: `PATH 二进制（${onPath}）` };
  }
  const manifest = path.join(repoDir, "crates", "zome-sidecar", "Cargo.toml");
  const cargo = await findOnPath("cargo", pathEnv, exists);
  if (cargo && (await exists(manifest))) {
    return { command: cargo, args: ["run", "--manifest-path", manifest], display: `cargo run（${manifest}）` };
  }
  return undefined;
}

// —— 进程内状态（spec 决策 5：仅内存，本进程 spawn 的 child 引用；
// engine 崩溃侧由 sidecar 收编监控的既有语义兜底） ——
let spawnedChild: ChildProcess | undefined;

/** 测试专用：清进程内 child 引用（不杀进程——测试用假 child 无真实进程） */
export function __resetAutostartForTest(): void {
  spawnedChild = undefined;
}

/** 测试专用：本进程是否有在管 child（smoke 断言真拉起用） */
export function __hasSpawnedChildForTest(): boolean {
  return spawnedChild !== undefined;
}

/**
 * 自启唤醒（spec 决策 1/2/4）：开关缺省 false 直返（与现状恒等）；
 * 纳用优先——已有健康 sidecar 在跑直接纳用不重复 spawn；发现序全灭 warn
 * 降级；spawn 后**不等就绪**（健康检查自然接管，向量检索本按健康降级）；
 * spawn 'error' 记 error 一次不重试。任何内部失败只降级不抛出。
 */
export async function startSidecarIfEnabled(deps: AutostartDeps): Promise<void> {
  let enabled = false;
  try {
    const config = await deps.configRepository.load();
    enabled = config.settings.sidecarAutoStart === true;
  } catch (err) {
    logger.warn({ err: err }, "[sidecar-autostart] 读取配置失败，按开关关处理（恒等降级）");
    return;
  }
  if (!enabled) return;

  if (deps.sidecarClient && (await deps.sidecarClient.isAvailable(ADOPT_PROBE_MS))) {
    logger.info("[sidecar-autostart] 已有健康 sidecar 在跑，纳用不重复 spawn");
    return;
  }

  const bin = await resolveSidecarBin(deps);
  if (!bin) {
    logger.warn("[sidecar-autostart] sidecar 二进制发现序全灭（ZOME_SIDECAR_BIN / 仓内 target / PATH / cargo 均无），按 sidecar 缺席降级（引擎照常）");
    return;
  }

  const spawnFn = deps.spawnFn ?? spawn;
  const child = spawnFn(bin.command, bin.args, {
    detached: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ZOME_SIDECAR_ADDR: process.env.ZOME_SIDECAR_ADDR || DEFAULT_SIDECAR_ADDR,
      CLOUDMIND_DATA_DIR: getDataDir(),
      ZOME_LOG_LEVEL: process.env.ZOME_LOG_LEVEL || "info",
    },
  });
  spawnedChild = child;
  // spawn 失败（ENOENT/EACCES）：error 记一次，不重试风暴（spec 决策 4）
  child.once("error", (err) => {
    if (spawnedChild === child) spawnedChild = undefined;
    logger.error({ err: err, display: bin.display }, "[sidecar-autostart] spawn 失败，按 sidecar 缺席降级（不重试）");
  });
  child.once("exit", (code, signal) => {
    if (spawnedChild === child) spawnedChild = undefined;
    logger.warn({ code, signal }, "[sidecar-autostart] sidecar 进程退出");
  });
  // stdio pipe 进 pino warn 级（spec 决策 6）
  child.stdout?.on("data", (chunk: Buffer) => logger.warn(`[sidecar] ${String(chunk).trimEnd()}`));
  child.stderr?.on("data", (chunk: Buffer) => logger.warn(`[sidecar] ${String(chunk).trimEnd()}`));
  logger.info(`[sidecar-autostart] 已拉起 sidecar（${bin.display}），健康检查自然接管`);
}

/** POSIX 两段式（spec 决策 5）：SIGTERM → 超时 SIGKILL；Windows taskkill /T /F（MCP 同纪律） */
async function terminateChild(child: ChildProcess, killAfterMs: number): Promise<void> {
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      killer.once("exit", () => resolve());
      killer.once("error", () => resolve());
    });
    return;
  }
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  try {
    child.kill("SIGTERM");
  } catch (err) {
    logger.warn({ err: err }, "[sidecar-autostart] SIGTERM 发送失败（进程可能已退出）");
    return;
  }
  const deadline = Date.now() + killAfterMs;
  while (!exited && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  if (!exited) {
    logger.warn(`[sidecar-autostart] SIGTERM ${killAfterMs}ms 未退出，升级 SIGKILL`);
    try {
      child.kill("SIGKILL");
    } catch (err) {
      logger.warn({ err: err }, "[sidecar-autostart] SIGKILL 发送失败（进程可能已退出）");
    }
  }
}

/**
 * 关停（engine shutdown 链调用）：两段式终止本进程 spawn 的 sidecar；
 * 全程不抛（浮空 promise 禁令——内部异常一律 warn 吞掉，不阻断退出）。
 */
export async function stopSidecar(opts?: { killAfterMs?: number }): Promise<void> {
  const child = spawnedChild;
  spawnedChild = undefined;
  if (!child) return;
  try {
    await terminateChild(child, opts?.killAfterMs ?? SIGKILL_AFTER_MS);
  } catch (err) {
    logger.warn({ err: err }, "[sidecar-autostart] 关停 sidecar 异常（不阻断退出）");
  }
}
