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
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "compute-api-test-"));
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

describe("Compute API", () => {
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

  it("creates and lists providers with masked api keys", async () => {
    const app = await makeApp();
    const provider = {
      id: "p1",
      displayName: "OpenAI",
      providerType: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      models: [{ id: "gpt-4o", displayName: "GPT-4o", modelType: "llm" as const }],
    };
    const createRes = await authedRequest(app.server).post("/compute/providers").send(provider);
    expect(createRes.status).toBe(200);
    expect(createRes.body.displayName).toBe("OpenAI");
    expect(createRes.body.apiKey).toBe("***");

    const listRes = await authedRequest(app.server).get("/compute/providers");
    expect(listRes.status).toBe(200);
    expect(listRes.body).toHaveLength(1);
    expect(listRes.body[0].apiKey).toBe("***");
    await app.close();
  });

  it("updates and deletes a provider", async () => {
    const app = await makeApp();
    const provider = {
      id: "p1",
      displayName: "OpenAI",
      providerType: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      models: [],
    };
    await authedRequest(app.server).post("/compute/providers").send(provider);

    const updateRes = await authedRequest(app.server).put("/compute/providers/p1").send({ displayName: "OpenAI Updated" });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.displayName).toBe("OpenAI Updated");

    const delRes = await authedRequest(app.server).delete("/compute/providers/p1");
    expect(delRes.status).toBe(204);

    const listRes = await authedRequest(app.server).get("/compute/providers");
    expect(listRes.body).toHaveLength(0);
    await app.close();
  });

  it("keeps the existing apiKey when update sends an empty string", async () => {
    const app = await makeApp();
    const provider = {
      id: "p1",
      displayName: "OpenAI",
      providerType: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      models: [],
    };
    await authedRequest(app.server).post("/compute/providers").send(provider);

    // 编辑表单留空表示"不修改"，不能把已保存的密钥覆盖掉
    const updateRes = await authedRequest(app.server)
      .put("/compute/providers/p1")
      .send({ displayName: "Renamed", apiKey: "" });
    expect(updateRes.status).toBe(200);

    const config = await context.configRepository.load();
    expect(config.providers[0].displayName).toBe("Renamed");
    expect(config.providers[0].apiKey).toBe("sk-test");
    await app.close();
  });

  it("manages models under a provider", async () => {
    const app = await makeApp();
    const provider = {
      id: "p1",
      displayName: "OpenAI",
      providerType: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      models: [],
    };
    await authedRequest(app.server).post("/compute/providers").send(provider);

    const model = { id: "gpt-4o", displayName: "GPT-4o", modelType: "llm" };
    const addRes = await authedRequest(app.server).post("/compute/providers/p1/models").send(model);
    expect(addRes.status).toBe(200);

    const updateRes = await authedRequest(app.server).put("/compute/providers/p1/models/gpt-4o").send({ displayName: "GPT-4o Updated" });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.displayName).toBe("GPT-4o Updated");

    const delRes = await authedRequest(app.server).delete("/compute/providers/p1/models/gpt-4o");
    expect(delRes.status).toBe(204);

    const listRes = await authedRequest(app.server).get("/compute/providers");
    expect(listRes.body[0].models).toHaveLength(0);
    await app.close();
  });

  it("rejects localhost baseUrl", async () => {
    const app = await makeApp();
    const res = await authedRequest(app.server).post("/compute/providers").send({
      id: "local",
      displayName: "Local",
      providerType: "openai",
      baseUrl: "http://localhost:11434",
      models: [],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid baseUrl");
    await app.close();
  });

  it("rejects metadata IP baseUrl", async () => {
    const app = await makeApp();
    const res = await authedRequest(app.server).post("/compute/providers").send({
      id: "metadata",
      displayName: "Metadata",
      providerType: "openai",
      baseUrl: "http://169.254.169.254",
      models: [],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid baseUrl");
    await app.close();
  });

  it("rejects non-http schemes baseUrl", async () => {
    const app = await makeApp();
    const res = await authedRequest(app.server).post("/compute/providers").send({
      id: "file",
      displayName: "File",
      providerType: "openai",
      baseUrl: "file:///etc/passwd",
      models: [],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid baseUrl");
    await app.close();
  });

  it("rejects IPv6 loopback baseUrl", async () => {
    const app = await makeApp();
    const res = await authedRequest(app.server).post("/compute/providers").send({
      id: "v6loop",
      displayName: "V6Loop",
      providerType: "openai",
      baseUrl: "http://[::1]:11434",
      models: [],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid baseUrl");
    await app.close();
  });

  it("rejects non-.1 loopback baseUrl", async () => {
    const app = await makeApp();
    const res = await authedRequest(app.server).post("/compute/providers").send({
      id: "loop2",
      displayName: "Loop2",
      providerType: "openai",
      baseUrl: "http://127.0.0.2:11434",
      models: [],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid baseUrl");
    await app.close();
  });

  // WHATWG URL 会把这些 IPv4-mapped/compatible 形式归一化为 hex，
  // 拦截逻辑必须按 hex 段解析，否则全部绕过
  it.each([
    "http://[::ffff:127.0.0.1]/", // mapped loopback
    "http://[::ffff:169.254.169.254]/", // mapped 云元数据
    "http://[::ffff:7f00:1]/", // hex 形式直接传入
    "http://[::127.0.0.1]/", // compatible loopback
    "http://[::ffff:ac10:fe01]/", // mapped 内网 172.16.254.1
    "http://[::]/", // unspecified
  ])("rejects IPv4-mapped/compatible IPv6 baseUrl: %s", async (baseUrl) => {
    const app = await makeApp();
    const res = await authedRequest(app.server).post("/compute/providers").send({
      id: "v6mapped",
      displayName: "V6Mapped",
      providerType: "openai",
      baseUrl,
      models: [],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid baseUrl");
    await app.close();
  });

  it("allows a public IPv4-mapped IPv6 baseUrl (不误伤)", async () => {
    const app = await makeApp();
    const res = await authedRequest(app.server).post("/compute/providers").send({
      id: "v6public",
      displayName: "V6Public",
      providerType: "openai",
      baseUrl: "http://[::ffff:8.8.8.8]/",
      models: [],
    });
    expect(res.status).toBe(200);
    await app.close();
  });

  it("allows valid http/https external baseUrl", async () => {
    const app = await makeApp();
    const res = await authedRequest(app.server).post("/compute/providers").send({
      id: "external",
      displayName: "External",
      providerType: "openai",
      baseUrl: "https://api.openai.com/v1",
      models: [],
    });
    expect(res.status).toBe(200);
    expect(res.body.baseUrl).toBe("https://api.openai.com/v1");
    await app.close();
  });
});
