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

async function buildContext(agentId: string): Promise<{ context: ApiContext; cleanup: () => Promise<void> }> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "scheduler-api-test-"));
  const originalDataDir = process.env.CLOUDMIND_DATA_DIR;
  process.env.CLOUDMIND_DATA_DIR = tmpDir;

  const agentRepository = new AgentRepository();
  await agentRepository.save(agentId, {
    id: agentId,
    name: "Test",
    persona: "",
    model: "mock",
    skills: [],
    tools: [],
  });

  const context: ApiContext = {
    agentRepository,
    getMessageRepository: (id: string) => new MessageRepository(id),
    getMemoryRepository: (id: string) => new MemoryRepository(id),
    getActionRepository: (id: string) => new ActionRepository(id),
    getLLMCallRepository: (id: string) => new LLMCallRepository(id),
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

describe("Scheduler API", () => {
  let context: ApiContext;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const built = await buildContext("a1");
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

  it("returns 400 for invalid agent id", async () => {
    const app = await makeApp();
    const res = await authedRequest(app.server).get("/scheduler/invalid!");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid agent id");
    await app.close();
  });

  it("M28：POST /scheduler/:agentId 缺 body 返回 400 不 500", async () => {
    const app = await makeApp();
    // 无 content-type 无 body：request.body 为 undefined，原先 TypeError 500
    const res = await authedRequest(app.server).post("/scheduler/a1");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("description, prompt, cron required");
    await app.close();
  });

  it("M28：PUT /scheduler/:agentId/:taskId 缺 body 按无字段变更 no-op 处理（不 500）", async () => {
    const app = await makeApp();
    const createRes = await authedRequest(app.server).post("/scheduler/a1").send({
      description: "task",
      prompt: "do it",
      cron: "0 9 * * *",
    });
    expect(createRes.status).toBe(200);

    const res = await authedRequest(app.server).put(`/scheduler/a1/${createRes.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body.description).toBe("task");
    await app.close();
  });

  it("M32：DELETE 不存在 task 返回 404（不再恒 204）", async () => {
    const app = await makeApp();
    const res = await authedRequest(app.server).delete("/scheduler/a1/nope");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Task not found");
    await app.close();
  });
});
