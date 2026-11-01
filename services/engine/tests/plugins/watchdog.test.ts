import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Context } from "cordis";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { restoreDataDir } from "../helpers/env.js";
import * as configPlugin from "../../src/plugins/config/index.js";
import * as watchdogPlugin from "../../src/plugins/watchdog/index.js";
import {
  DEFAULT_STALL_THRESHOLD_MS,
  TOOL_GRACE_MS,
  type WatchdogFace,
} from "../../src/plugins/watchdog/index.js";
import type { TurnHeartbeat } from "../../src/core/agent-worker.js";
import type { WatchdogSettings } from "../../src/config/repository.js";

/**
 * 看门狗插件（P3）：扫描判定与可观测面。
 *
 * 不启真进程、不等真定时器——插件 apply 后立刻扫一轮（首轮 tick 在挂载时
 * 发起、之后才按周期排程），所以「挂载 → 观察是否中断」就能覆盖判定逻辑，
 * 不必把测试拖到 5 秒一个扫描周期。
 */
describe("plugins/watchdog（P3）", () => {
  let tempDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "watchdog-plugin-test-"));
    originalDataDir = process.env.CLOUDMIND_DATA_DIR;
    process.env.CLOUDMIND_DATA_DIR = tempDir;
  });

  afterEach(async () => {
    restoreDataDir(originalDataDir);
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  interface FakeWorker {
    agentId: string;
    getHeartbeat: () => TurnHeartbeat | undefined;
    abortCurrentTurn: ReturnType<typeof vi.fn>;
  }

  function makeWorker(agentId: string, heartbeat: TurnHeartbeat | undefined): FakeWorker {
    return {
      agentId,
      getHeartbeat: () => heartbeat,
      abortCurrentTurn: vi.fn(() => heartbeat !== undefined),
    };
  }

  /** 挂载 config + 假 agents + watchdog，返回上架面与中断记录 */
  async function mountWatchdog(
    workers: FakeWorker[],
    settings?: WatchdogSettings,
  ): Promise<{ face: WatchdogFace | undefined; dispose: () => Promise<void> }> {
    const ctx = new Context();
    await ctx.plugin(configPlugin);
    const cfg = await ctx.config.load();
    if (settings !== undefined) {
      await ctx.config.save({ ...cfg, settings: { ...cfg.settings, watchdog: settings } });
    }
    // agents 只被消费 workspaceRegistry.all()：给一个最小满足面即可，
    // 不引真 WorkerRegistry（那会拉起整条 worker 创建链）
    ctx.provide("agents", { workerRegistry: { all: () => workers } } as never);

    let face: WatchdogFace | undefined;
    const fiber = await ctx.plugin(watchdogPlugin, {
      onProvide: (provided: WatchdogFace) => {
        face = provided;
      },
    });
    return {
      face,
      dispose: async () => {
        await fiber.dispose();
      },
    };
  }

  /** 已经停滞 ms 时长的心跳 */
  function stalledHeartbeat(idleMs: number, overrides: Partial<TurnHeartbeat> = {}): TurnHeartbeat {
    const now = Date.now();
    return {
      startedAt: now - idleMs - 1_000,
      lastActivityAt: now - idleMs,
      stepCount: 3,
      ...overrides,
    };
  }

  it("停滞超过阈值：中断并带 reason=watchdog", async () => {
    const worker = makeWorker("agent-1", stalledHeartbeat(DEFAULT_STALL_THRESHOLD_MS + 5_000));
    const { dispose } = await mountWatchdog([worker]);

    await vi.waitFor(() => {
      expect(worker.abortCurrentTurn).toHaveBeenCalledWith("watchdog");
    });
    await dispose();
  });

  it("未超阈值：不中断（不能把正常慢回合当故障杀掉）", async () => {
    const worker = makeWorker("agent-1", stalledHeartbeat(1_000));
    const { dispose } = await mountWatchdog([worker]);

    // 首轮扫描是挂载即发起的；等到它跑完再断言「没动手」
    await new Promise((r) => setTimeout(r, 150));
    expect(worker.abortCurrentTurn).not.toHaveBeenCalled();
    await dispose();
  });

  it("工具在跑且未超自报上限：按工具上限放宽，不中断", async () => {
    // 已停滞 11 分钟 > 缺省阈值 10 分钟，但工具自报 20 分钟——
    // run_command 这类合法长跑不能被当成卡死
    const worker = makeWorker(
      "agent-1",
      stalledHeartbeat(11 * 60_000, {
        activeTool: { name: "run_command", timeoutMs: 20 * 60_000 },
      }),
    );
    const { dispose } = await mountWatchdog([worker]);

    await new Promise((r) => setTimeout(r, 150));
    expect(worker.abortCurrentTurn).not.toHaveBeenCalled();
    await dispose();
  });

  it("工具自报上限已过（含宽限）：照常中断", async () => {
    // 基础阈值压到 60s，工具自报 120s——此时生效阈值是 120s + 宽限。
    // 停滞 185s 已越过这条线，就该中断（工具确实卡住了，不是在长跑）
    const toolLimit = 2 * 60_000;
    const worker = makeWorker(
      "agent-1",
      stalledHeartbeat(toolLimit + TOOL_GRACE_MS + 5_000, {
        activeTool: { name: "run_command", timeoutMs: toolLimit },
      }),
    );
    const { face, dispose } = await mountWatchdog([worker], { stallThresholdMs: 60_000 });

    const snapshot = await face!.snapshot();
    expect(snapshot.turns[0].thresholdMs).toBe(toolLimit + TOOL_GRACE_MS);
    await vi.waitFor(() => {
      expect(worker.abortCurrentTurn).toHaveBeenCalledWith("watchdog");
    });
    await dispose();
  });

  it("enabled=false：完全不扫描（不中断、不报错）", async () => {
    const worker = makeWorker("agent-1", stalledHeartbeat(DEFAULT_STALL_THRESHOLD_MS * 3));
    const { face, dispose } = await mountWatchdog([worker], { enabled: false });

    await new Promise((r) => setTimeout(r, 150));
    expect(worker.abortCurrentTurn).not.toHaveBeenCalled();
    // 关掉时快照仍可用：排查时要知道「是关着的」，而不是看起来像没在跑
    const snapshot = await face!.snapshot();
    expect(snapshot.enabled).toBe(false);
    await dispose();
  });

  it("没有在途 turn 的 worker 不参与判定", async () => {
    const idleWorker = makeWorker("agent-idle", undefined);
    const stalledWorker = makeWorker("agent-stalled", stalledHeartbeat(DEFAULT_STALL_THRESHOLD_MS + 5_000));
    const { face, dispose } = await mountWatchdog([idleWorker, stalledWorker]);

    await vi.waitFor(() => {
      expect(stalledWorker.abortCurrentTurn).toHaveBeenCalled();
    });
    expect(idleWorker.abortCurrentTurn).not.toHaveBeenCalled();

    const snapshot = await face!.snapshot();
    // 只有真正在跑的回合出现在快照里
    expect(snapshot.turns.map((t) => t.agentId)).toEqual(["agent-stalled"]);
    await dispose();
  });

  it("快照如实报告 idleMs 与生效阈值：区分「挂了」和「只是慢」", async () => {
    const worker = makeWorker(
      "agent-1",
      stalledHeartbeat(30_000, { activeTool: { name: "run_command", timeoutMs: 600_000 } }),
    );
    const { face, dispose } = await mountWatchdog([worker], { stallThresholdMs: 60_000 });

    const snapshot = await face!.snapshot();
    expect(snapshot.enabled).toBe(true);
    expect(snapshot.stallThresholdMs).toBe(60_000);
    const turn = snapshot.turns[0];
    expect(turn.agentId).toBe("agent-1");
    expect(turn.idleMs).toBeGreaterThanOrEqual(30_000);
    // 工具在跑：阈值被放宽到工具上限 + 宽限，而不是配置里的 60s
    expect(turn.thresholdMs).toBe(600_000 + TOOL_GRACE_MS);
    expect(turn.activeTool).toEqual({ name: "run_command", timeoutMs: 600_000 });
    // 时间字段用 ISO，前端/curl 都能直接读
    expect(turn.lastActivityAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    await dispose();
  });

  it("非法阈值配置回缺省：0 / 负数 / NaN 不能把看护关成永不触发", async () => {
    const worker = makeWorker("agent-1", stalledHeartbeat(DEFAULT_STALL_THRESHOLD_MS + 5_000));
    const { face, dispose } = await mountWatchdog([worker], { stallThresholdMs: 0 });

    const snapshot = await face!.snapshot();
    expect(snapshot.stallThresholdMs).toBe(DEFAULT_STALL_THRESHOLD_MS);
    // 归一到缺省后，超阈值的回合照样会被中断
    await vi.waitFor(() => {
      expect(worker.abortCurrentTurn).toHaveBeenCalled();
    });
    await dispose();
  });
});
