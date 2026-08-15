import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Context } from "cordis";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkerRegistry } from "../../src/core/worker-registry.js";
import { restoreDataDir } from "../helpers/env.js";
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

// P6 agents 插件挂载测试：inject 全阵容 PENDING 语义 + 合体 + onChange 接线 +
// config 回调过渡形态（闭包延迟求值——桩件仅挂不进调用）。
describe("plugins/agents（P6）", () => {
  let tempDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agents-plugin-test-"));
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

  it("inject 全阵容未就位时不激活（PENDING）", async () => {
    const ctx = new Context();
    const fiber = ctx.plugin(agentsPlugin, agentsConfig);
    // cordis rc.8：await fiber 对 PENDING 立即落定，激活与否看 fiber.state（PENDING=0）
    await fiber;
    expect(fiber.state).toBe(0);
    expect(ctx.get("agents")).toBeUndefined();
  });

  it("全依赖就位后激活：agentRepository 合体 + workerRegistry + onChange 接线收在插件内", async () => {
    const ctx = new Context();
    await mountDeps(ctx);
    await ctx.plugin(agentsPlugin, agentsConfig);

    // 合体：agents.agentRepository 就是 ctx.memory 的单例本体
    expect(ctx.agents.agentRepository).toBe(ctx.memory.agentRepository);
    expect(ctx.agents.workerRegistry).toBeInstanceOf(WorkerRegistry);
    expect(typeof ctx.agents.getOrCreateWorker).toBe("function");
    expect(typeof ctx.agents.retire).toBe("function");
    // onChange→retire 接线收进插件内部（不再跨 bootstrap）
    expect(typeof ctx.memory.agentRepository.onChange).toBe("function");
  });

  it("config 回调缺失即炸（P4 skills 同风格）", async () => {
    const ctx = new Context();
    await mountDeps(ctx);
    await expect(ctx.plugin(agentsPlugin, {} as never)).rejects.toThrow(/getSubagentServices/);
  });
});
