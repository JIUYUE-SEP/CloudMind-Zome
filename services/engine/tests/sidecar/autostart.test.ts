import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fastify from "fastify";
import { logger } from "../../src/logger.js";
import {
  resolveSidecarBin,
  startSidecarIfEnabled,
  stopSidecar,
  __resetAutostartForTest,
  type AutostartDeps,
} from "../../src/sidecar/autostart.js";
import { ConfigRepository } from "../../src/config/repository.js";
import { registerConfigRoutes } from "../../src/api/routes/config.js";
import type { ApiContext } from "../../src/api/context.js";
import { restoreDataDir } from "../helpers/env.js";

/** 假子进程（生产真形状的 EventEmitter 面：stdout/stderr/error/exit/kill） */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  pid = 12345;
  killCalls: Array<string | undefined> = [];
  kill(signal?: string): boolean {
    this.killCalls.push(signal);
    return true;
  }
}

function fakeConfigRepo(enabled: boolean | "throw") {
  return {
    load: async () => {
      if (enabled === "throw") throw new Error("config unreadable");
      return { settings: { sidecarAutoStart: enabled } };
    },
  } as unknown as AutostartDeps["configRepository"];
}

function makeDeps(overrides: Partial<AutostartDeps> = {}): AutostartDeps & { spawnCalls: unknown[][]; child: FakeChild; probeCalls: (number | undefined)[] } {
  const child = new FakeChild();
  const spawnCalls: unknown[][] = [];
  const probeCalls: (number | undefined)[] = [];
  const deps: AutostartDeps = {
    configRepository: fakeConfigRepo(true),
    sidecarClient: {
      isAvailable: async (deadlineMs?: number) => {
        probeCalls.push(deadlineMs);
        return false;
      },
    },
    spawnFn: ((...args: unknown[]) => {
      spawnCalls.push(args);
      return child;
    }) as unknown as AutostartDeps["spawnFn"],
    existsFn: async () => false,
    envBin: undefined,
    pathEnv: "",
    repoDir: "/repo",
    ...overrides,
  };
  return { ...deps, spawnCalls, child, probeCalls };
}

beforeEach(() => {
  __resetAutostartForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetAutostartForTest();
});

describe("resolveSidecarBin 发现序（决策 3）", () => {
  const base = { envBin: undefined as string | undefined, pathEnv: "", repoDir: "/repo" };

  it("逐档：envBin → release → debug → PATH → cargo 兜底 → 全灭 undefined", async () => {
    const exists = (set: Set<string>) => async (p: string) => set.has(p);

    // 1. envBin 优先
    const r1 = await resolveSidecarBin({ ...base, envBin: "/opt/sidecar", existsFn: exists(new Set(["/opt/sidecar"])) });
    expect(r1).toMatchObject({ command: "/opt/sidecar", args: [] });

    // 2. 仓内 release
    const release = "/repo/crates/zome-sidecar/target/release/zome-sidecar";
    const r2 = await resolveSidecarBin({ ...base, envBin: "/missing", existsFn: exists(new Set([release])) });
    expect(r2).toMatchObject({ command: release, args: [] });

    // 3. 仓内 debug
    const debug = "/repo/crates/zome-sidecar/target/debug/zome-sidecar";
    const r3 = await resolveSidecarBin({ ...base, existsFn: exists(new Set([debug])) });
    expect(r3).toMatchObject({ command: debug, args: [] });

    // 4. PATH
    const r4 = await resolveSidecarBin({ ...base, pathEnv: "/binA:/binB", existsFn: exists(new Set(["/binB/zome-sidecar"])) });
    expect(r4).toMatchObject({ command: "/binB/zome-sidecar", args: [] });

    // 5. cargo 兜底（无二进制但 PATH 有 cargo 且 manifest 在）
    const manifest = "/repo/crates/zome-sidecar/Cargo.toml";
    const r5 = await resolveSidecarBin({ ...base, pathEnv: "/usr/bin", existsFn: exists(new Set(["/usr/bin/cargo", manifest])) });
    expect(r5).toMatchObject({ command: "/usr/bin/cargo", args: ["run", "--manifest-path", manifest] });

    // 6. 全灭
    const r6 = await resolveSidecarBin({ ...base, existsFn: exists(new Set()) });
    expect(r6).toBeUndefined();
  });
});

describe("startSidecarIfEnabled（决策 1/2/4）", () => {
  it("开关缺省/false：零 spawn 零探活（恒等）", async () => {
    for (const enabled of [false]) {
      const deps = makeDeps({ configRepository: fakeConfigRepo(enabled) });
      await startSidecarIfEnabled(deps);
      expect(deps.spawnCalls).toHaveLength(0);
      expect(deps.probeCalls).toHaveLength(0);
    }
  });

  it("配置读取失败：warn 降级不抛，零 spawn", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const deps = makeDeps({ configRepository: fakeConfigRepo("throw") });
    await expect(startSidecarIfEnabled(deps)).resolves.toBeUndefined();
    expect(deps.spawnCalls).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
  });

  it("健康纳用短路：已有健康 sidecar 零 spawn（200ms 短超时探活）", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    const deps = makeDeps({
      sidecarClient: {
        isAvailable: async (deadlineMs?: number) => {
          deps.probeCalls.push(deadlineMs);
          return true;
        },
      },
    });
    await startSidecarIfEnabled(deps);
    expect(deps.probeCalls).toEqual([200]);
    expect(deps.spawnCalls).toHaveLength(0);
    expect(info.mock.calls.some((c) => String(c[0]).includes("纳用"))).toBe(true);
  });

  it("发现序全灭：warn 一次降级，零 spawn 不抛", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const deps = makeDeps();
    await expect(startSidecarIfEnabled(deps)).resolves.toBeUndefined();
    expect(deps.spawnCalls).toHaveLength(0);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("发现序全灭"))).toHaveLength(1);
  });

  it("spawn 成功：env 三键注入 + stdio pipe，不等就绪直接返回", async () => {
    const binPath = "/repo/crates/zome-sidecar/target/release/zome-sidecar";
    const deps = makeDeps({ existsFn: async (p) => p === binPath });
    await startSidecarIfEnabled(deps);
    expect(deps.spawnCalls).toHaveLength(1);
    const [command, args, opts] = deps.spawnCalls[0] as [string, string[], { env: Record<string, string | undefined>; stdio: unknown[]; detached: boolean }];
    expect(command).toBe(binPath);
    expect(args).toEqual([]);
    expect(opts.detached).toBe(false);
    expect(opts.env.ZOME_SIDECAR_ADDR).toBeTruthy();
    expect(opts.env.CLOUDMIND_DATA_DIR).toBeTruthy();
    expect(opts.env.ZOME_LOG_LEVEL).toBeTruthy();
  });

  it("spawn error：error 记一次不重试，child 引用清理后 stopSidecar 空转", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => {});
    const deps = makeDeps({ existsFn: async () => true });
    await startSidecarIfEnabled(deps);
    deps.child.emit("error", new Error("ENOENT"));
    expect(error).toHaveBeenCalledTimes(1);
    expect(deps.spawnCalls).toHaveLength(1);
    await stopSidecar({ killAfterMs: 10 });
    expect(deps.child.killCalls).toHaveLength(0);
  });
});

describe("stopSidecar 两段式关停（决策 5）", () => {
  it("SIGTERM 后进程退出：不升级 SIGKILL", async () => {
    const deps = makeDeps({ existsFn: async () => true });
    await startSidecarIfEnabled(deps);
    const stopping = stopSidecar({ killAfterMs: 200 });
    await new Promise((r) => setTimeout(r, 30));
    deps.child.emit("exit", 0, null);
    await stopping;
    expect(deps.child.killCalls).toEqual(["SIGTERM"]);
  });

  it("SIGTERM 超时未退出：升级 SIGKILL", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const deps = makeDeps({ existsFn: async () => true });
    await startSidecarIfEnabled(deps);
    await stopSidecar({ killAfterMs: 50 });
    expect(deps.child.killCalls).toEqual(["SIGTERM", "SIGKILL"]);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("升级 SIGKILL"))).toBe(true);
  });

  it("无 child：空转不抛", async () => {
    await expect(stopSidecar()).resolves.toBeUndefined();
  });
});

describe("config 面：sidecarAutoStart 读写（决策 1 默认 false 恒等）", () => {
  let tmpDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sidecar-autostart-config-"));
    originalDataDir = process.env.CLOUDMIND_DATA_DIR;
    process.env.CLOUDMIND_DATA_DIR = tmpDir;
  });

  afterEach(async () => {
    restoreDataDir(originalDataDir);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("repository：缺省缺席（false 语义）；update 写 true 后 load 命中", async () => {
    const repo = new ConfigRepository();
    const initial = await repo.load();
    expect(initial.settings.sidecarAutoStart).toBeUndefined();

    await repo.update((cfg) => {
      cfg.settings.sidecarAutoStart = true;
    });
    const after = await repo.load();
    expect(after.settings.sidecarAutoStart).toBe(true);
  });

  it("PUT /config：boolean 透传落盘回显；非 boolean 不修改", async () => {
    const app = fastify();
    await registerConfigRoutes(app, { configRepository: new ConfigRepository() } as unknown as ApiContext);

    const put1 = await app.inject({
      method: "PUT",
      url: "/config",
      payload: { sidecarAutoStart: true },
    });
    expect(put1.statusCode).toBe(200);
    expect(put1.json().sidecarAutoStart).toBe(true);

    const put2 = await app.inject({
      method: "PUT",
      url: "/config",
      payload: { sidecarAutoStart: "yes" },
    });
    expect(put2.statusCode).toBe(200);
    expect(put2.json().sidecarAutoStart).toBe(true); // 非 boolean 不修改，保留前值

    const get = await app.inject({ method: "GET", url: "/config" });
    expect(get.json().sidecarAutoStart).toBe(true);
    await app.close();
  });
});
