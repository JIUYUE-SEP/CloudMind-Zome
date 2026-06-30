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
import type { ChatMessageRecord } from "../../src/memory/repositories/types.js";

async function buildTestContext(): Promise<{ context: ApiContext; cleanup: () => Promise<void> }> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sessions-api-test-"));
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

describe("Sessions API", () => {
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

  it("lists sessions", async () => {
    const app = await makeApp();
    const res = await request(app.server).get("/sessions");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    await app.close();
  });

  it("creates a session", async () => {
    const app = await makeApp();
    const res = await request(app.server).post("/sessions").send({ name: "Team", agentIds: ["a1", "a2"] });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Team");
    expect(res.body.agentIds).toEqual(["a1", "a2"]);
    expect(res.body.type).toBe("group");
    await app.close();
  });

  it("validates session creation", async () => {
    const app = await makeApp();
    const res = await request(app.server).post("/sessions").send({ name: "Team" });
    expect(res.status).toBe(400);
    await app.close();
  });

  it("rejects session creation with invalid agent id", async () => {
    const app = await makeApp();
    const res = await request(app.server).post("/sessions").send({ name: "Team", agentIds: ["a1", "bad id!"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid agent id in agentIds");
    await app.close();
  });

  it("updates a session", async () => {
    const app = await makeApp();
    const session = await context.sessionRepository.create({
      name: "Team",
      agentIds: ["a1", "a2"],
      type: "group",
    });
    const res = await request(app.server).put(`/sessions/${session.id}`).send({ name: "Crew", agentIds: ["a3"] });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Crew");
    expect(res.body.agentIds).toEqual(["a3"]);
    await app.close();
  });

  it("rejects session update with invalid agent id", async () => {
    const app = await makeApp();
    const session = await context.sessionRepository.create({
      name: "Team",
      agentIds: ["a1", "a2"],
      type: "group",
    });
    const res = await request(app.server).put(`/sessions/${session.id}`).send({ agentIds: ["a1", "bad id!"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid agent id in agentIds");
    await app.close();
  });

  it("gets session messages aggregated from all agents", async () => {
    const app = await makeApp();
    const session = await context.sessionRepository.create({
      name: "Team",
      agentIds: ["a1", "a2"],
      type: "group",
    });

    const msg1: ChatMessageRecord = {
      id: "m1",
      sessionId: session.id,
      role: "user",
      content: [{ type: "text", text: "hi" }],
      createdAt: new Date(Date.now() - 1000).toISOString(),
    };
    const msg2: ChatMessageRecord = {
      id: "m2",
      sessionId: session.id,
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      createdAt: new Date().toISOString(),
    };
    await context.getMessageRepository("a1").append(msg1);
    await context.getMessageRepository("a2").append(msg2);

    const res = await request(app.server).get(`/sessions/${session.id}/messages`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].id).toBe("m1");
    expect(res.body[1].id).toBe("m2");
    await app.close();
  });
});
