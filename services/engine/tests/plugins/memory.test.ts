import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Context } from "cordis";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentRepository } from "../../src/memory/repositories/agent.js";
import { MessageRepository } from "../../src/memory/repositories/message.js";
import { restoreDataDir } from "../helpers/env.js";
import * as memoryPlugin from "../../src/plugins/memory/index.js";

// P4 memory 插件挂载测试：ctx.memory 上架面（单例 agentRepository + per-agent
// 工厂现造语义 + recall + reconcile 三入口）。
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
  });

  it("ctx.memory 上架：agentRepository 单例 + recall + reconcile 入口", async () => {
    const ctx = new Context();
    await ctx.plugin(memoryPlugin);
    expect(ctx.memory.agentRepository).toBeInstanceOf(AgentRepository);
    expect(typeof ctx.memory.reconcileHotStorage).toBe("function");
    expect(typeof ctx.memory.reconcileOrphanedTopic).toBe("function");
    expect(typeof ctx.memory.reconcilePendingSegments).toBe("function");
    expect(ctx.memory.recall).toBeDefined();
  });

  it("repository 工厂面：per-call 现造（不缓存），类型正确", async () => {
    const ctx = new Context();
    await ctx.plugin(memoryPlugin);
    const r1 = ctx.memory.getMessageRepository("a1");
    const r2 = ctx.memory.getMessageRepository("a1");
    expect(r1).toBeInstanceOf(MessageRepository);
    expect(r2).toBeInstanceOf(MessageRepository);
    expect(r1).not.toBe(r2); // per-call 现造语义（与原 ApiContext 工厂一致）
  });
});
