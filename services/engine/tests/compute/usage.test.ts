import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { authedRequest } from "../helpers/auth.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { aggregateUsage } from "../../src/compute/usage.js";
import { logger } from "../../src/logger.js";
import { createServer } from "../../src/api/server.js";
import { AgentRepository } from "../../src/memory/repositories/agent.js";
import { MessageRepository } from "../../src/memory/repositories/message.js";
import { MemoryRepository } from "../../src/memory/repositories/memory.js";
import { ActionRepository } from "../../src/memory/repositories/action.js";
import { LLMCallRepository } from "../../src/memory/repositories/llm-call.js";
import { ConfigRepository } from "../../src/config/repository.js";
import { SessionRepository } from "../../src/conductor/repository.js";
import { BlueprintRepository } from "../../src/blueprint/repository.js";
import type { ApiContext } from "../../src/api/context.js";
import type { FastifyInstance } from "fastify";
import { restoreDataDir } from "../helpers/env.js";

/** 本地时区构造 ISO 时间戳：聚合按本地日期分桶，测试数据跨时区均稳定 */
function localISO(year: number, month: number, day: number, hour = 12): string {
  return new Date(year, month - 1, day, hour, 0, 0).toISOString();
}

async function writeLlmCalls(agentDir: string, lines: string[]): Promise<void> {
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(path.join(agentDir, "llm_calls.jsonl"), lines.join("\n") + "\n", "utf-8");
}

let tmpDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "compute-usage-test-"));
  originalDataDir = process.env.CLOUDMIND_DATA_DIR;
  process.env.CLOUDMIND_DATA_DIR = tmpDir;
});

afterEach(async () => {
  restoreDataDir(originalDataDir);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("aggregateUsage", () => {
  it("跨两天/两模型/两 agent 聚合，errorCalls 计数，token=0 照常计入，坏行跳过", async () => {
    await writeLlmCalls(path.join(tmpDir, "agents", "a1"), [
      JSON.stringify({
        id: "1", agentId: "a1", provider: "openai", model: "gpt-4o",
        promptTokens: 100, completionTokens: 50, status: "ok",
        createdAt: localISO(2026, 8, 3),
      }),
      JSON.stringify({
        id: "2", agentId: "a1", provider: "anthropic", model: "claude-3-5-sonnet",
        promptTokens: 200, completionTokens: 100, status: "error", error: "boom",
        createdAt: localISO(2026, 8, 3),
      }),
      // token=0 的历史记录：照常计入调用数
      JSON.stringify({
        id: "3", agentId: "a1", provider: "openai", model: "gpt-4o",
        promptTokens: 0, completionTokens: 0, status: "ok",
        createdAt: localISO(2026, 8, 3),
      }),
      "坏行 {{{ 不应中断聚合",
    ]);
    await writeLlmCalls(path.join(tmpDir, "agents", "a2"), [
      JSON.stringify({
        id: "4", agentId: "a2", provider: "openai", model: "gpt-4o",
        promptTokens: 300, completionTokens: 150, status: "ok",
        createdAt: localISO(2026, 8, 3),
      }),
      JSON.stringify({
        id: "5", agentId: "a2", provider: "openai", model: "gpt-4o-mini",
        promptTokens: 50, completionTokens: 25, status: "ok",
        createdAt: localISO(2026, 8, 4),
      }),
    ]);

    const usage = await aggregateUsage();
    expect(usage).toEqual({
      dates: [
        { date: "2026-08-03", promptTokens: 600, completionTokens: 300, calls: 4, errorCalls: 1 },
        { date: "2026-08-04", promptTokens: 50, completionTokens: 25, calls: 1, errorCalls: 0 },
      ],
      tokens: [
        { provider: "anthropic", model: "claude-3-5-sonnet", promptTokens: 200, completionTokens: 100, calls: 1 },
        { provider: "openai", model: "gpt-4o", promptTokens: 400, completionTokens: 200, calls: 3 },
        { provider: "openai", model: "gpt-4o-mini", promptTokens: 50, completionTokens: 25, calls: 1 },
      ],
      byAgent: [
        { agentId: "a1", promptTokens: 300, completionTokens: 150, calls: 3 },
        { agentId: "a2", promptTokens: 350, completionTokens: 175, calls: 2 },
      ],
    });
  });

  it("缺 agentId/provider 的记录按目录归属、provider 记 unknown", async () => {
    await writeLlmCalls(path.join(tmpDir, "agents", "a1"), [
      JSON.stringify({
        id: "legacy", model: "old-model",
        promptTokens: 10, completionTokens: 5, status: "ok",
        createdAt: localISO(2026, 8, 3),
      }),
    ]);

    const usage = await aggregateUsage();
    expect(usage.byAgent).toEqual([{ agentId: "a1", promptTokens: 10, completionTokens: 5, calls: 1 }]);
    expect(usage.tokens).toEqual([
      { provider: "unknown", model: "old-model", promptTokens: 10, completionTokens: 5, calls: 1 },
    ]);
  });

  it("null/true 等非对象行按坏行跳过，不崩溃", async () => {
    await writeLlmCalls(path.join(tmpDir, "agents", "a1"), [
      "null",
      "true",
      JSON.stringify({
        id: "1", agentId: "a1", provider: "openai", model: "gpt-4o",
        promptTokens: 10, completionTokens: 5, status: "ok",
        createdAt: localISO(2026, 8, 3),
      }),
    ]);

    const usage = await aggregateUsage();
    expect(usage).toEqual({
      dates: [{ date: "2026-08-03", promptTokens: 10, completionTokens: 5, calls: 1, errorCalls: 0 }],
      tokens: [{ provider: "openai", model: "gpt-4o", promptTokens: 10, completionTokens: 5, calls: 1 }],
      byAgent: [{ agentId: "a1", promptTokens: 10, completionTokens: 5, calls: 1 }],
    });
  });

  it("负数 token 按 0 计入，调用数照常", async () => {
    await writeLlmCalls(path.join(tmpDir, "agents", "a1"), [
      JSON.stringify({
        id: "neg", agentId: "a1", provider: "openai", model: "gpt-4o",
        promptTokens: -5, completionTokens: 10, status: "ok",
        createdAt: localISO(2026, 8, 3),
      }),
    ]);

    const usage = await aggregateUsage();
    expect(usage.dates).toEqual([
      { date: "2026-08-03", promptTokens: 0, completionTokens: 10, calls: 1, errorCalls: 0 },
    ]);
    expect(usage.tokens).toEqual([
      { provider: "openai", model: "gpt-4o", promptTokens: 0, completionTokens: 10, calls: 1 },
    ]);
  });

  it("记录 agentId 与目录名不一致：warn 且目录名胜出", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await writeLlmCalls(path.join(tmpDir, "agents", "a1"), [
        JSON.stringify({
          id: "drift", agentId: "a2", provider: "openai", model: "gpt-4o",
          promptTokens: 10, completionTokens: 5, status: "ok",
          createdAt: localISO(2026, 8, 3),
        }),
      ]);

      const usage = await aggregateUsage();
      expect(usage.byAgent).toEqual([{ agentId: "a1", promptTokens: 10, completionTokens: 5, calls: 1 }]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ recordAgentId: "a2", agentId: "a1" }),
        expect.stringContaining("不一致"),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("单文件读失败（EISDIR）只跳过该 agent，不中断聚合", async () => {
    // Windows 下目录可 open 但读流抛 EISDIR；POSIX 下 open 即抛 EISDIR——两条路径都覆盖
    await fs.mkdir(path.join(tmpDir, "agents", "a1", "llm_calls.jsonl"), { recursive: true });
    await writeLlmCalls(path.join(tmpDir, "agents", "a2"), [
      JSON.stringify({
        id: "1", agentId: "a2", provider: "openai", model: "gpt-4o",
        promptTokens: 10, completionTokens: 5, status: "ok",
        createdAt: localISO(2026, 8, 3),
      }),
    ]);

    const usage = await aggregateUsage();
    expect(usage.byAgent).toEqual([{ agentId: "a2", promptTokens: 10, completionTokens: 5, calls: 1 }]);
    expect(usage.dates).toEqual([
      { date: "2026-08-03", promptTokens: 10, completionTokens: 5, calls: 1, errorCalls: 0 },
    ]);
  });

  it("agents 目录缺失/为空/无 llm_calls.jsonl 时返回空数组不报错", async () => {
    expect(await aggregateUsage()).toEqual({ dates: [], tokens: [], byAgent: [] });

    await fs.mkdir(path.join(tmpDir, "agents", "empty-agent"), { recursive: true });
    expect(await aggregateUsage()).toEqual({ dates: [], tokens: [], byAgent: [] });
  });
});

describe("GET /compute/usage", () => {
  let context: ApiContext;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const built = await buildContext();
    context = built.context;
    cleanup = built.cleanup;
  });

  afterEach(async () => {
    await cleanup();
  });

  async function makeApp(): Promise<FastifyInstance> {
    const app = await createServer(context);
    await app.ready();
    return app;
  }

  it("返回 dates/tokens/byAgent 聚合形状", async () => {
    await writeLlmCalls(path.join(tmpDir, "agents", "a1"), [
      JSON.stringify({
        id: "1", agentId: "a1", provider: "openai", model: "gpt-4o",
        promptTokens: 10, completionTokens: 5, status: "error", error: "boom",
        createdAt: localISO(2026, 8, 3),
      }),
    ]);
    const app = await makeApp();
    const res = await authedRequest(app.server).get("/compute/usage");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      dates: [{ date: "2026-08-03", promptTokens: 10, completionTokens: 5, calls: 1, errorCalls: 1 }],
      tokens: [{ provider: "openai", model: "gpt-4o", promptTokens: 10, completionTokens: 5, calls: 1 }],
      byAgent: [{ agentId: "a1", promptTokens: 10, completionTokens: 5, calls: 1 }],
    });
    await app.close();
  });

  it("单文件读失败不拖垮端点", async () => {
    await fs.mkdir(path.join(tmpDir, "agents", "a1", "llm_calls.jsonl"), { recursive: true });
    await writeLlmCalls(path.join(tmpDir, "agents", "a2"), [
      JSON.stringify({
        id: "1", agentId: "a2", provider: "openai", model: "gpt-4o",
        promptTokens: 10, completionTokens: 5, status: "ok",
        createdAt: localISO(2026, 8, 3),
      }),
    ]);
    const app = await makeApp();
    const res = await authedRequest(app.server).get("/compute/usage");
    expect(res.status).toBe(200);
    expect(res.body.byAgent).toEqual([{ agentId: "a2", promptTokens: 10, completionTokens: 5, calls: 1 }]);
    await app.close();
  });
});

async function buildContext(): Promise<{ context: ApiContext; cleanup: () => Promise<void> }> {
  const context: ApiContext = {
    agentRepository: new AgentRepository(),
    getMessageRepository: (agentId: string) => new MessageRepository(agentId),
    getMemoryRepository: (agentId: string) => new MemoryRepository(agentId),
    getActionRepository: (agentId: string) => new ActionRepository(agentId),
    getLLMCallRepository: (agentId: string) => new LLMCallRepository(agentId),
    configRepository: new ConfigRepository(),
    sessionRepository: new SessionRepository(),
    blueprintRepository: new BlueprintRepository(),
    getAgentWorker: async () => undefined,
  };
  return {
    context,
    cleanup: async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
      restoreDataDir(originalDataDir);
    },
  };
}
