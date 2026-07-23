import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { authedRequest } from "../helpers/auth.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

async function buildContext(): Promise<{ context: ApiContext; cleanup: () => Promise<void> }> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "config-api-test-"));
  const originalDataDir = process.env.CLOUDMIND_DATA_DIR;
  process.env.CLOUDMIND_DATA_DIR = tmpDir;

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

describe("Config API", () => {
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

  it("returns default config with tools", async () => {
    const app = await makeApp();
    const res = await authedRequest(app.server).get("/config");
    expect(res.status).toBe(200);
    expect(res.body.memory).toBeDefined();
    expect(res.body.providers).toEqual([]);

    const toolsRes = await authedRequest(app.server).get("/config/tools");
    expect(toolsRes.status).toBe(200);
    expect(toolsRes.body.length).toBeGreaterThan(0);
    expect(toolsRes.body[0]).toHaveProperty("toolset", "builtin");
    await app.close();
  });

  it("updates memory settings and tavily key", async () => {
    const app = await makeApp();
    const updateRes = await authedRequest(app.server).put("/config").send({
      memory: { keepRecent: 5 },
      tavilyApiKey: "tvly-test",
    });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.memory.keepRecent).toBe(5);
    expect(updateRes.body.tavilyApiKey).toBe("***");

    const getRes = await authedRequest(app.server).get("/config");
    expect(getRes.body.memory.keepRecent).toBe(5);
    expect(getRes.body.tavilyApiKey).toBe("***");

    // 落盘的值经过加密且可解回原文
    const raw = JSON.parse(
      await fs.readFile(path.join(process.env.CLOUDMIND_DATA_DIR!, "config.json"), "utf-8"),
    );
    expect(raw.settings.tavilyApiKey).toMatch(/^enc:/);
    const loaded = await context.configRepository.load();
    expect(loaded.settings.tavilyApiKey).toBe("tvly-test");
    await app.close();
  });

  it("does not overwrite tavily key when mask '***' is sent back", async () => {
    const app = await makeApp();
    await authedRequest(app.server).put("/config").send({ tavilyApiKey: "tvly-real" });

    // 前端把 GET 到的掩码原样 PUT 回来时，真实密钥必须保持不动
    const res = await authedRequest(app.server).put("/config").send({ tavilyApiKey: "***" });
    expect(res.status).toBe(200);

    const loaded = await context.configRepository.load();
    expect(loaded.settings.tavilyApiKey).toBe("tvly-real");
    await app.close();
  });

  it("clears tavily key when empty string is sent", async () => {
    const app = await makeApp();
    await authedRequest(app.server).put("/config").send({ tavilyApiKey: "tvly-real" });

    // 空字符串 = 清除 key
    const res = await authedRequest(app.server).put("/config").send({ tavilyApiKey: "" });
    expect(res.status).toBe(200);
    expect(res.body.tavilyApiKey).toBeUndefined();

    const loaded = await context.configRepository.load();
    expect(loaded.settings.tavilyApiKey).toBeUndefined();

    const getRes = await authedRequest(app.server).get("/config");
    expect(getRes.body.tavilyApiKey).toBeUndefined();
    await app.close();
  });

  it("does not modify tavily key when the field is omitted", async () => {
    const app = await makeApp();
    await authedRequest(app.server).put("/config").send({ tavilyApiKey: "tvly-real" });

    // undefined（字段缺失）= 不修改，哪怕同请求带了其他配置项
    const res = await authedRequest(app.server).put("/config").send({ memory: { keepRecent: 7 } });
    expect(res.status).toBe(200);
    expect(res.body.tavilyApiKey).toBe("***");

    const loaded = await context.configRepository.load();
    expect(loaded.settings.tavilyApiKey).toBe("tvly-real");
    expect(loaded.settings.memory.keepRecent).toBe(7);
    await app.close();
  });
});
