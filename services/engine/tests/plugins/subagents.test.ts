import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Context } from "cordis";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { restoreDataDir } from "../helpers/env.js";
import { SubagentDispatcher } from "../../src/subagent/dispatcher.js";
import { BackgroundManager } from "../../src/subagent/background.js";
import { SubagentSwarm } from "../../src/subagent/batch.js";
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
import * as intermindPlugin from "../../src/plugins/intermind/index.js";
import * as subagentsPlugin from "../../src/plugins/subagents/index.js";

// P7d subagents 插件挂载测试：inject 全阵容 PENDING 语义 + ctx.subagents
// 上架面（dispatcher/backgroundManager/swarm/puppetModelService/runAgentCollect）
// + apply 完成即完成启动对账（subagent-tasks.jsonl running 标 lost，handoff
// P7b 同款先例）。agents 依赖链挂载形态同 tests/plugins/plans.test.ts。
describe("plugins/subagents（P7d）", () => {
  let tempDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "subagents-plugin-test-"));
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
    await ctx.plugin(intermindPlugin);
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

  it("插件元数据：name / inject 全阵容 / apply 四件套可读", () => {
    expect(subagentsPlugin.name).toBe("subagents");
    expect(subagentsPlugin.inject).toEqual(["config", "llm", "tools", "compute", "agents", "memory", "intermind"]);
    expect(typeof subagentsPlugin.apply).toBe("function");
  });

  it("inject 全阵容未就位时不激活（PENDING）", async () => {
    const ctx = new Context();
    const fiber = ctx.plugin(subagentsPlugin);
    // cordis rc.8：await fiber 对 PENDING 立即落定，激活与否看 fiber.state（PENDING=0）
    await fiber;
    expect(fiber.state).toBe(0);
    expect(ctx.get("subagents")).toBeUndefined();
  });

  it("ctx.subagents 上架面：dispatcher/backgroundManager/swarm/puppetModelService/runAgentCollect 就位", async () => {
    const ctx = new Context();
    await mountDeps(ctx);
    await ctx.plugin(subagentsPlugin);

    expect(ctx.subagents.dispatcher).toBeInstanceOf(SubagentDispatcher);
    expect(ctx.subagents.backgroundManager).toBeInstanceOf(BackgroundManager);
    expect(ctx.subagents.swarm).toBeInstanceOf(SubagentSwarm);
    expect(typeof ctx.subagents.puppetModelService.list).toBe("function");
    expect(typeof ctx.subagents.runAgentCollect).toBe("function");

    // 型号库冒烟：内置四型号可读（DATA_DIR/puppet-models 缺失按空，不炸）
    const planner = await ctx.subagents.puppetModelService.get("规划师");
    expect(planner?.personaSnippet).toContain("规划师");
    expect(planner?.suggestedTools).toContain("read_file");
    expect((await ctx.subagents.puppetModelService.list()).filter((m) => m.source === "builtin")).toHaveLength(4);

    // runAgentCollect 经 ctx.agents 取 worker：agent 不存在抛 not found（不建 worker）
    await expect(ctx.subagents.runAgentCollect("nonexistent", [])).rejects.toThrow("Agent nonexistent not found");
  });

  it("apply 完成即完成启动对账：running 标 lost 回填索引，终态记录保留", async () => {
    // 预置任务表：一条 running（重启前未完成）+ 一条 completed
    await fs.writeFile(
      path.join(tempDir, "subagent-tasks.jsonl"),
      [
        JSON.stringify({
          taskId: "t-running",
          parentAgentId: "a1",
          agentId: "a2",
          kind: "delegate",
          taskDescription: "do work",
          status: "running",
          outputPreview: "",
          outputTruncated: false,
          startTime: 1,
          timeoutMs: 120_000,
          attempts: 1,
          notified: false,
        }),
        JSON.stringify({
          taskId: "t-done",
          parentAgentId: "a1",
          agentId: "a2",
          kind: "puppet",
          taskDescription: "done work",
          status: "completed",
          outputPreview: "ok",
          outputTruncated: false,
          startTime: 1,
          endTime: 2,
          timeoutMs: 120_000,
          attempts: 1,
          notified: true,
        }),
      ].join("\n") + "\n",
      "utf-8",
    );

    const ctx = new Context();
    await mountDeps(ctx);
    await ctx.plugin(subagentsPlugin);

    // await plugin() 落定 = 对账已完成（原 bootstrap listen 前 load 时序）：
    // running → lost；终态记录原样回填内存索引
    expect(ctx.subagents.backgroundManager.get("t-running")).toMatchObject({ status: "lost" });
    expect(ctx.subagents.backgroundManager.get("t-done")).toMatchObject({
      status: "completed",
      output: "ok",
      kind: "puppet",
    });
  });
});
