import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
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
import type { ApiContext } from "../../src/api/context.js";
import type { FastifyInstance } from "fastify";

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
    getAgentWorker: async () => undefined,
  };

  return {
    context,
    cleanup: async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
      process.env.CLOUDMIND_DATA_DIR = originalDataDir;
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
    const createRes = await request(app.server).post("/compute/providers").send(provider);
    expect(createRes.status).toBe(200);
    expect(createRes.body.displayName).toBe("OpenAI");
    expect(createRes.body.apiKey).toBe("sk-test");

    const listRes = await request(app.server).get("/compute/providers");
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
    await request(app.server).post("/compute/providers").send(provider);

    const updateRes = await request(app.server).put("/compute/providers/p1").send({ displayName: "OpenAI Updated" });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.displayName).toBe("OpenAI Updated");

    const delRes = await request(app.server).delete("/compute/providers/p1");
    expect(delRes.status).toBe(204);

    const listRes = await request(app.server).get("/compute/providers");
    expect(listRes.body).toHaveLength(0);
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
    await request(app.server).post("/compute/providers").send(provider);

    const model = { id: "gpt-4o", displayName: "GPT-4o", modelType: "llm" };
    const addRes = await request(app.server).post("/compute/providers/p1/models").send(model);
    expect(addRes.status).toBe(200);

    const updateRes = await request(app.server).put("/compute/providers/p1/models/gpt-4o").send({ displayName: "GPT-4o Updated" });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.displayName).toBe("GPT-4o Updated");

    const delRes = await request(app.server).delete("/compute/providers/p1/models/gpt-4o");
    expect(delRes.status).toBe(204);

    const listRes = await request(app.server).get("/compute/providers");
    expect(listRes.body[0].models).toHaveLength(0);
    await app.close();
  });
});
