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
      restoreDataDir(originalDataDir);
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
    const res = await authedRequest(app.server).get("/blueprints");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    await app.close();
  });

  it("creates and gets a blueprint", async () => {
    const app = await makeApp();
    const createRes = await authedRequest(app.server).post("/blueprints").send({ name: "Test" });
    expect(createRes.status).toBe(200);
    expect(createRes.body.name).toBe("Test");

    const getRes = await authedRequest(app.server).get(`/blueprints/${createRes.body.id}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.name).toBe("Test");
    await app.close();
  });

  it("updates and deletes a blueprint", async () => {
    const app = await makeApp();
    const createRes = await authedRequest(app.server).post("/blueprints").send({ name: "Test" });
    const id = createRes.body.id;

    const putRes = await authedRequest(app.server).put(`/blueprints/${id}`).send({ name: "Updated" });
    expect(putRes.status).toBe(200);
    expect(putRes.body.name).toBe("Updated");

    const delRes = await authedRequest(app.server).delete(`/blueprints/${id}`);
    expect(delRes.status).toBe(204);

    const getRes = await authedRequest(app.server).get(`/blueprints/${id}`);
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
    const createRes = await authedRequest(app.server).post("/blueprints").send(blueprint);
    const execRes = await authedRequest(app.server)
      .post(`/blueprints/${createRes.body.id}/execute`)
      .send({ initialInput: "hello" });
    expect(execRes.status).toBe(200);
    expect(execRes.body.status).toBe("completed");
    expect(execRes.body.outputs.end).toBe("hello");
    await app.close();
  });

  it("M28：写端点缺 body 不 500（POST 400；PUT/execute 按空 body 处理）", async () => {
    const app = await makeApp();
    // 无 content-type 无 body：request.body 为 undefined，原先 TypeError 500
    const createRes = await authedRequest(app.server).post("/blueprints");
    expect(createRes.status).toBe(400);
    expect(createRes.body.error).toBe("name required");

    const created = await authedRequest(app.server).post("/blueprints").send({ name: "Keep" });
    const id = created.body.id;
    // 空 body PUT = 无字段变更的 no-op，不再 500
    const putRes = await authedRequest(app.server).put(`/blueprints/${id}`);
    expect(putRes.status).toBe(200);
    expect(putRes.body.name).toBe("Keep");
    // 空 body execute = initialInput 缺省
    const execRes = await authedRequest(app.server).post(`/blueprints/${id}/execute`);
    expect(execRes.status).toBe(200);
    await app.close();
  });

  it("M32：DELETE 不存在 blueprint 返回 404（不再恒 204）", async () => {
    const app = await makeApp();
    const res = await authedRequest(app.server).delete("/blueprints/nope");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Blueprint not found");
    await app.close();
  });
});
