import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Context } from "cordis";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentRepository } from "../../src/memory/repositories/agent.js";
import { MessageRepository } from "../../src/memory/repositories/message.js";
import { restoreDataDir } from "../helpers/env.js";
import * as logPlugin from "../../src/plugins/log/index.js";
import * as configPlugin from "../../src/plugins/config/index.js";
import * as llmPlugin from "../../src/plugins/llm/index.js";
import * as toolsPlugin from "../../src/plugins/tools/index.js";
import * as memoryPlugin from "../../src/plugins/memory/index.js";
import * as mindPlugin from "../../src/plugins/mind/index.js";
import * as pipelinePlugin from "../../src/plugins/pipeline/index.js";
import * as computePlugin from "../../src/plugins/compute/index.js";
import * as skillsPlugin from "../../src/plugins/skills/index.js";
import * as agentsPlugin from "../../src/plugins/agents/index.js";
import * as schedulerPlugin from "../../src/plugins/scheduler/index.js";

// P4 memory 插件挂载测试：ctx.memory 上架面（单例 agentRepository + per-agent
// 工厂现造语义 + recall + reconcile 三入口）。
// P9：inject 追加 ["llm", "mind"]（启动对账依赖），挂载需先备齐依赖；
// 新增 engine/ready 驱动冒烟——serial 发射触发对账执行，且调用序在
// scheduler.start 之前（注册序 = 激活序：memory 先于 scheduler）。
describe("plugins/memory（P4）", () => {
  let tempDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-plugin-test-"));
    originalDataDir = process.env.CLOUDMIND_DATA_DIR;
    process.env.CLOUDMIND_DATA_DIR = tempDir;
  });

  afterEach(async () => {
    restoreDataDir(originalDataDir);
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /** P9 起 memory inject ["llm", "mind"]：先挂依赖再挂 memory（llm 另需 config） */
  async function mountMemory(ctx: Context): Promise<void> {
    await ctx.plugin(configPlugin);
    await ctx.plugin(llmPlugin);
    await ctx.plugin(mindPlugin);
    await ctx.plugin(memoryPlugin);
  }

  it("ctx.memory 上架：agentRepository 单例 + recall + reconcile 入口", async () => {
    const ctx = new Context();
    await mountMemory(ctx);
    expect(ctx.memory.agentRepository).toBeInstanceOf(AgentRepository);
    expect(typeof ctx.memory.reconcileHotStorage).toBe("function");
    expect(typeof ctx.memory.reconcileOrphanedTopic).toBe("function");
    expect(typeof ctx.memory.reconcilePendingSegments).toBe("function");
    expect(ctx.memory.recall).toBeDefined();
  });

  it("repository 工厂面：per-call 现造（不缓存），类型正确", async () => {
    const ctx = new Context();
    await mountMemory(ctx);
    const r1 = ctx.memory.getMessageRepository("a1");
    const r2 = ctx.memory.getMessageRepository("a1");
    expect(r1).toBeInstanceOf(MessageRepository);
    expect(r2).toBeInstanceOf(MessageRepository);
    expect(r1).not.toBe(r2); // per-call 现造语义（与原 ApiContext 工厂一致）
  });

  it("inject ['llm', 'mind'] 未就位时不激活（PENDING）", async () => {
    const ctx = new Context();
    const fiber = ctx.plugin(memoryPlugin);
    // cordis rc.8：await fiber 对 PENDING 立即落定，激活与否看 fiber.state（PENDING=0）
    await fiber;
    expect(fiber.state).toBe(0);
    expect(ctx.get("memory")).toBeUndefined();
  });

  describe("engine/ready 启动对账（P9）", () => {
    const agentsConfig = {
      getSubagentServices: () => ({
        subagentDispatcher: {} as never,
        subagentSwarm: {} as never,
        puppetModelService: {} as never,
        intermindService: {} as never,
      }),
      getSidecar: () => ({} as never),
    };

    /** memory → scheduler 全链（scheduler inject agents；挂载序同 bootstrap） */
    async function mountChain(ctx: Context): Promise<void> {
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
      await ctx.plugin(schedulerPlugin);
    }

    it("serial 发射触发对账执行，且调用序在 scheduler.start 之前", async () => {
      const ctx = new Context();
      await mountChain(ctx);
      await ctx.memory.agentRepository.save("agent-1", {
        id: "agent-1",
        name: "a1",
        persona: "",
        model: "mock",
        skills: [],
        tools: [],
      });

      const order: string[] = [];
      // 对账 spy 穿透到真实实现（空数据目录 reconcileHotStorage 快速返回 0）
      const origReconcile = ctx.memory.reconcileHotStorage;
      const reconcileSpy = vi
        .spyOn(ctx.memory, "reconcileHotStorage")
        .mockImplementation(async (agentId, repo) => {
          order.push("reconcile");
          return origReconcile(agentId, repo);
        });
      // start spy 不穿透：只记序，不起真实 5s 轮询计时器
      const startSpy = vi.spyOn(ctx.scheduler, "start").mockImplementation(() => {
        order.push("scheduler.start");
      });

      await ctx.serial("engine/ready");

      expect(reconcileSpy).toHaveBeenCalledWith("agent-1", expect.any(MessageRepository));
      expect(startSpy).toHaveBeenCalledTimes(1);
      // serial 按注册序等待：memory（先激活）的对账先于 scheduler 的 start
      expect(order).toEqual(["reconcile", "scheduler.start"]);
    });

    it("ZOME_STARTUP_RECONCILE=false 关闭对账（scheduler.start 仍按序触发）", async () => {
      const ctx = new Context();
      await mountChain(ctx);
      await ctx.memory.agentRepository.save("agent-1", {
        id: "agent-1",
        name: "a1",
        persona: "",
        model: "mock",
        skills: [],
        tools: [],
      });

      const reconcileSpy = vi.spyOn(ctx.memory, "reconcileHotStorage");
      const startSpy = vi.spyOn(ctx.scheduler, "start").mockImplementation(() => {});
      process.env.ZOME_STARTUP_RECONCILE = "false";
      try {
        await ctx.serial("engine/ready");
      } finally {
        delete process.env.ZOME_STARTUP_RECONCILE;
      }

      expect(reconcileSpy).not.toHaveBeenCalled();
      expect(startSpy).toHaveBeenCalledTimes(1);
    });
  });
});
