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
import { BlueprintRepository } from "../../src/blueprint/repository.js";
import type { ApiContext } from "../../src/api/context.js";
import type { FastifyInstance } from "fastify";

async function buildTestContext(): Promise<{ context: ApiContext; cleanup: () => Promise<void> }> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "blueprint-api-test-"));
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
      process.env.CLOUDMIND_DATA_DIR = originalDataDir;
    },
  };
}

describe("Blueprint API", () => {
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

  it("lists blueprints", async () => {
    const app = await makeApp();
    const res = await request(app.server).get("/blueprints");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    await app.close();
  });

  it("creates and gets a blueprint", async () => {
    const app = await makeApp();
    const createRes = await request(app.server).post("/blueprints").send({ name: "Test" });
    expect(createRes.status).toBe(200);
    expect(createRes.body.name).toBe("Test");

    const getRes = await request(app.server).get(`/blueprints/${createRes.body.id}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.name).toBe("Test");
    await app.close();
  });

  it("updates and deletes a blueprint", async () => {
    const app = await makeApp();
    const createRes = await request(app.server).post("/blueprints").send({ name: "Test" });
    const id = createRes.body.id;

    const putRes = await request(app.server).put(`/blueprints/${id}`).send({ name: "Updated" });
    expect(putRes.status).toBe(200);
    expect(putRes.body.name).toBe("Updated");

    const delRes = await request(app.server).delete(`/blueprints/${id}`);
    expect(delRes.status).toBe(204);

    const getRes = await request(app.server).get(`/blueprints/${id}`);
    expect(getRes.status).toBe(404);
    await app.close();
  });

  it("executes a blueprint", async () => {
    const app = await makeApp();
    const blueprint = {
      name: "Exec",
      nodes: [
        { id: "start", type: "start", x: 0, y: 0 },
        { id: "end", type: "end", x: 200, y: 0 },
      ],
      edges: [{ source: "start", target: "end" }],
    };
    const createRes = await request(app.server).post("/blueprints").send(blueprint);
    const execRes = await request(app.server)
      .post(`/blueprints/${createRes.body.id}/execute`)
      .send({ initialInput: "hello" });
    expect(execRes.status).toBe(200);
    expect(execRes.body.status).toBe("completed");
    expect(execRes.body.outputs.end).toBe("hello");
    await app.close();
  });
});
