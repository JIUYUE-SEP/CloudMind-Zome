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
import type { ApiContext } from "../../src/api/context.js";
import type { FastifyInstance } from "fastify";

async function buildTestContext(): Promise<{ context: ApiContext; cleanup: () => Promise<void> }> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "api-test-"));
  const originalDataDir = process.env.CLOUDMIND_DATA_DIR;
  process.env.CLOUDMIND_DATA_DIR = tmpDir;

  const context: ApiContext = {
    agentRepository: new AgentRepository(),
    getMessageRepository: (agentId: string) => new MessageRepository(agentId),
    getMemoryRepository: (agentId: string) => new MemoryRepository(agentId),
    getActionRepository: (agentId: string) => new ActionRepository(agentId),
    getLLMCallRepository: (agentId: string) => new LLMCallRepository(agentId),
    getAgentWorker: () => undefined,
  };

  return {
    context,
    cleanup: async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
      process.env.CLOUDMIND_DATA_DIR = originalDataDir;
    },
  };
}

describe("Agent API", () => {
  let context: ApiContext;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const built = await buildTestContext();
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

  it("lists agents", async () => {
    const app = await makeApp();
    const res = await request(app.server).get("/agents");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    await app.close();
  });

  it("creates and gets an agent", async () => {
    const app = await makeApp();
    const agent = { id: "a1", name: "A1", persona: "", model: "mock", skills: [], tools: [] };
    const createRes = await request(app.server).post("/agents").send(agent);
    expect(createRes.status).toBe(200);
    expect(createRes.body.id).toBe("a1");

    const getRes = await request(app.server).get("/agents/a1");
    expect(getRes.status).toBe(200);
    expect(getRes.body.name).toBe("A1");
    await app.close();
  });

  it("updates an agent", async () => {
    const app = await makeApp();
    const agent = { id: "a1", name: "A1", persona: "", model: "mock", skills: [], tools: [] };
    await request(app.server).post("/agents").send(agent);

    const updated = { ...agent, name: "Updated" };
    const putRes = await request(app.server).put("/agents/a1").send(updated);
    expect(putRes.status).toBe(200);
    expect(putRes.body.name).toBe("Updated");
    await app.close();
  });

  it("deletes an agent", async () => {
    const app = await makeApp();
    const agent = { id: "a1", name: "A1", persona: "", model: "mock", skills: [], tools: [] };
    await request(app.server).post("/agents").send(agent);

    const delRes = await request(app.server).delete("/agents/a1");
    expect(delRes.status).toBe(204);

    const getRes = await request(app.server).get("/agents/a1");
    expect(getRes.status).toBe(404);
    await app.close();
  });
});
