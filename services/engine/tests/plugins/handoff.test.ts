import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Context } from "cordis";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { restoreDataDir } from "../helpers/env.js";
import { HandoffManager } from "../../src/handoff/manager.js";
import { HandoffLoopRegistry } from "../../src/handoff/registry.js";
import * as handoffPlugin from "../../src/plugins/handoff/index.js";

// P7b handoff 插件挂载测试：ctx.handoff 上架面（manager/loops/attachConnection
// 连接桥工厂）+ apply 完成即完成启动对账（handoff-state.json 活跃条目标 lost，
// 参照 tests/handoff/manager.test.ts 的对账 harness）。
describe("plugins/handoff（P7b）", () => {
  let tempDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "handoff-plugin-test-"));
    originalDataDir = process.env.CLOUDMIND_DATA_DIR;
    process.env.CLOUDMIND_DATA_DIR = tempDir;
  });

  afterEach(async () => {
    restoreDataDir(originalDataDir);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("插件元数据：name / inject 空 / apply 四件套可读", () => {
    expect(handoffPlugin.name).toBe("handoff");
    expect(handoffPlugin.inject).toEqual([]);
    expect(typeof handoffPlugin.apply).toBe("function");
  });

  it("ctx.handoff 上架：manager / loops / attachConnection 连接桥工厂", async () => {
    const ctx = new Context();
    await ctx.plugin(handoffPlugin);
    expect(ctx.handoff.manager).toBeInstanceOf(HandoffManager);
    expect(ctx.handoff.loops).toBeInstanceOf(HandoffLoopRegistry);
    expect(typeof ctx.handoff.attachConnection).toBe("function");

    // 连接桥工厂：attach 即建 loop + 注册进 registry（构造不触碰连接回调）
    const bridge = ctx.handoff.attachConnection({
      agentId: "a1",
      sessionId: "s1",
      send: () => {},
      sendJobEvent: () => {},
      loadHistory: async () => [],
      resolveWorker: async () => undefined,
      fallbackWorker: undefined as never,
    });
    expect(typeof bridge.onEvent).toBe("function");
    expect(typeof bridge.onEventWithChain).toBe("function");
    expect(typeof bridge.cancelUserMessage).toBe("function");
    expect(typeof bridge.detach).toBe("function");
  });

  it("apply 完成即完成启动对账：活跃条目标 lost，终态条目保留", async () => {
    // 预置控制面文件：一条活跃（running，含持久化 chainId）+ 一条终态（completed）
    await fs.writeFile(
      path.join(tempDir, "handoff-state.json"),
      JSON.stringify({
        handoffs: [
          {
            id: "ho_a1_s1",
            agentId: "a1",
            sessionId: "s1",
            reason: "watermark",
            status: "running",
            shift: 1,
            maxShifts: 3,
            bookText: "[交接书] 换班移交（第 1/3 棒）",
            used: 950,
            window: 1000,
            createdAt: 1,
            updatedAt: 1,
            chainId: "chain-old",
          },
          {
            id: "ho_a2_s2",
            agentId: "a2",
            sessionId: "s2",
            reason: "watermark",
            status: "completed",
            shift: 2,
            maxShifts: 3,
            bookText: "[交接书] 换班移交（第 2/3 棒）",
            used: 980,
            window: 1000,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      }),
      "utf-8",
    );

    const ctx = new Context();
    await ctx.plugin(handoffPlugin);

    // await plugin() 落定 = 对账已完成（原 bootstrap listen 前 load 时序）：
    // 活跃 running → lost（engine_restart），chainId 保留（闩锁权威数据不丢）；
    // 终态条目原样回填内存索引
    expect(ctx.handoff.manager.get("ho_a1_s1")).toMatchObject({
      status: "lost",
      abortReason: "engine_restart",
      chainId: "chain-old",
    });
    expect(ctx.handoff.manager.get("ho_a2_s2")).toMatchObject({ status: "completed" });
  });
});
