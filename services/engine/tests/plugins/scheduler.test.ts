import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Context } from "cordis";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { restoreDataDir } from "../helpers/env.js";
import { Scheduler } from "../../src/scheduler/scheduler.js";
import * as logPlugin from "../../src/plugins/log/index.js";
import * as configPlugin from "../../src/plugins/config/index.js";
import * as llmPlugin from "../../src/plugins/llm/index.js";
import * as toolsPlugin from "../../src/plugins/tools/index.js";
import * as skillsPlugin from "../../src/plugins/skills/index.js";
import * as memoryPlugin from "../../src/plugins/memory/index.js";
import * as mindPlugin from "../../src/plugins/mind/index.js";
import * as pipelinePlugin from "../../src/plugins/pipeline/index.js";
import * as computePlugin from "../../src/plugins/compute/index.js";
import * as agentsPlugin from "../../src/plugins/agents/index.js";
import * as schedulerPlugin from "../../src/plugins/scheduler/index.js";

// P7c scheduler 插件挂载测试：inject ['agents'] PENDING 语义 + ctx.scheduler
// 上架（Scheduler 实例本体）+ 5s 轮询选项随构造迁入 + start/stop 冒烟。
// agents 依赖链挂载形态同 tests/plugins/agents.test.ts（桩件仅挂不进调用）。
describe("plugins/scheduler（P7c）", () => {
  let tempDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "scheduler-plugin-test-"));
    originalDataDir = process.env.CLOUDMIND_DATA_DIR;
    process.env.CLOUDMIND_DATA_DIR = tempDir;
  });

  afterEach(async () => {
    restoreDataDir(originalDataDir);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function mountDeps(ctx: Context): Promise<void> {
    await ctx.plugin(logPlugin);
    await ctx.plugin(configPlugin);
    await ctx.plugin(llmPlugin);
    await ctx.plugin(toolsPlugin);
    await ctx.plugin(memoryPlugin);
    await ctx.plugin(mindPlugin);
    await ctx.plugin(pipelinePlugin);
    await ctx.plugin(computePlugin);
    await ctx.plugin(skillsPlugin, { getAgentConfig: async () => undefined });
    await ctx.plugin(agentsPlugin, agentsConfig);
  }

  const agentsConfig = {
    getSubagentServices: () => ({
      subagentDispatcher: {} as never,
      subagentSwarm: {} as never,
      puppetModelService: {} as never,
      intermindService: {} as never,
    }),
    getSidecar: () => ({} as never),
  };

  it("插件元数据：name / inject ['agents'] / apply 四件套可读", () => {
    expect(schedulerPlugin.name).toBe("scheduler");
    expect(schedulerPlugin.inject).toEqual(["agents"]);
    expect(typeof schedulerPlugin.apply).toBe("function");
  });

  it("inject ['agents'] 未就位时不激活（PENDING）", async () => {
    const ctx = new Context();
    const fiber = ctx.plugin(schedulerPlugin);
    // cordis rc.8：await fiber 对 PENDING 立即落定，激活与否看 fiber.state（PENDING=0）
    await fiber;
    expect(fiber.state).toBe(0);
    expect(ctx.get("scheduler")).toBeUndefined();
  });

  it("ctx.scheduler 上架：Scheduler 实例本体，5s 轮询选项随构造迁入", async () => {
    const ctx = new Context();
    await mountDeps(ctx);
    await ctx.plugin(schedulerPlugin);

    expect(ctx.scheduler).toBeInstanceOf(Scheduler);
    // 原 bootstrap `new Scheduler(context, { pollIntervalMs: 5000 })` 同值
    const internals = ctx.scheduler as unknown as { options: { pollIntervalMs?: number } };
    expect(internals.options.pollIntervalMs).toBe(5000);
  });

  it("start/stop 冒烟：重复 start 幂等 no-op，stop 清理计时器（原语义不变）", async () => {
    const ctx = new Context();
    await mountDeps(ctx);
    await ctx.plugin(schedulerPlugin);

    ctx.scheduler.start();
    ctx.scheduler.start();
    ctx.scheduler.stop();
    ctx.scheduler.start();
    ctx.scheduler.stop();
  });
});
