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

  it("M28：PUT /config 缺 body 按无字段变更 no-op 处理（不 500）", async () => {
    const app = await makeApp();
    // 无 content-type 无 body：request.body 为 undefined，原先 TypeError 500
    const res = await authedRequest(app.server).put("/config");
    expect(res.status).toBe(200);
    expect(res.body.memory).toBeDefined();
    await app.close();
  });

  it("并发两个 PUT 写不同字段不互丢（repository.update 串行化读-改-写）", async () => {
    const app = await makeApp();
    // 修复前：两请求各自 load 同一旧快照再分别 save，后写吞掉先写；
    // update() 把读-改-写并入同一写队列槽位，第二个请求读到第一个落盘后的最新配置
    const [r1, r2] = await Promise.all([
      authedRequest(app.server).put("/config").send({ memory: { keepRecent: 9 } }),
      authedRequest(app.server).put("/config").send({ tavilyApiKey: "tvly-conc" }),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    const loaded = await context.configRepository.load();
    expect(loaded.settings.memory.keepRecent).toBe(9);
    expect(loaded.settings.tavilyApiKey).toBe("tvly-conc");
    await app.close();
  });

  // ── 看护参数（P3/P4）：此前只能在 config.json 里手改，接口静默丢弃 ──

  it("PUT /config 写入 watchdog 分段，GET 能读回", async () => {
    const app = await makeApp();
    const res = await authedRequest(app.server)
      .put("/config")
      .send({ watchdog: { enabled: true, stallThresholdMs: 300_000 } });
    expect(res.status).toBe(200);
    expect(res.body.watchdog).toEqual({ enabled: true, stallThresholdMs: 300_000 });

    const loaded = await context.configRepository.load();
    expect(loaded.settings.watchdog).toEqual({ enabled: true, stallThresholdMs: 300_000 });
    await app.close();
  });

  it("watchdog 逐字段合并：只改一个字段不抹掉其余", async () => {
    const app = await makeApp();
    await authedRequest(app.server)
      .put("/config")
      .send({ watchdog: { stallThresholdMs: 300_000, scanIntervalMs: 10_000 } });
    // 第二次只动 enabled：另外两个必须留着（整体替换会让调参者以为配置没生效）
    await authedRequest(app.server).put("/config").send({ watchdog: { enabled: false } });

    const loaded = await context.configRepository.load();
    expect(loaded.settings.watchdog).toEqual({
      stallThresholdMs: 300_000,
      scanIntervalMs: 10_000,
      enabled: false,
    });
    await app.close();
  });

  it("semanticReview 嵌套合并：单改 enabled 不打回已配的冷却", async () => {
    const app = await makeApp();
    await authedRequest(app.server)
      .put("/config")
      .send({ watchdog: { semanticReview: { cooldownMs: 0, afterMs: 120_000 } } });
    await authedRequest(app.server)
      .put("/config")
      .send({ watchdog: { semanticReview: { enabled: true } } });

    const loaded = await context.configRepository.load();
    expect(loaded.settings.watchdog?.semanticReview).toEqual({
      cooldownMs: 0,
      afterMs: 120_000,
      enabled: true,
    });
    await app.close();
  });

  it("watchdog 形状非法（null / 数组 / 字符串）静默忽略，不写坏配置", async () => {
    const app = await makeApp();
    for (const bad of [null, ["enabled"], "off", 42]) {
      const res = await authedRequest(app.server).put("/config").send({ watchdog: bad });
      expect(res.status).toBe(200);
    }
    const loaded = await context.configRepository.load();
    expect(loaded.settings.watchdog).toBeUndefined();
    await app.close();
  });

  it("范围非法的值原样存下：归一在插件侧，接口不制造第二种失败面", async () => {
    const app = await makeApp();
    // 0 存进去，读取方（readSettings）回缺省——GET /system/watchdog 显示生效值
    await authedRequest(app.server).put("/config").send({ watchdog: { stallThresholdMs: 0 } });

    const loaded = await context.configRepository.load();
    expect(loaded.settings.watchdog?.stallThresholdMs).toBe(0);
    await app.close();
  });
});
