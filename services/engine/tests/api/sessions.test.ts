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
import type { ChatMessageRecord } from "../../src/memory/repositories/types.js";
import { restoreDataDir } from "../helpers/env.js";

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
      restoreDataDir(originalDataDir);
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
    const res = await authedRequest(app.server).get("/sessions");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    await app.close();
  });

  it("creates a session", async () => {
    const app = await makeApp();
    const res = await authedRequest(app.server).post("/sessions").send({ name: "Team", agentIds: ["a1", "a2"] });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Team");
    expect(res.body.agentIds).toEqual(["a1", "a2"]);
    expect(res.body.type).toBe("group");
    await app.close();
  });

  it("validates session creation", async () => {
    const app = await makeApp();
    const res = await authedRequest(app.server).post("/sessions").send({ name: "Team" });
    expect(res.status).toBe(400);
    await app.close();
  });

  it("M28：POST /sessions 缺 body 返回 400 不 500", async () => {
    const app = await makeApp();
    // 无 content-type 无 body：request.body 为 undefined，原先 TypeError 500
    const res = await authedRequest(app.server).post("/sessions");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("name and agentIds required");
    await app.close();
  });

  it("M28：PUT /sessions/:id 缺 body 按无字段变更 no-op 处理（不 500）", async () => {
    const app = await makeApp();
    const session = await context.sessionRepository.create({
      name: "Team",
      agentIds: ["a1"],
      type: "group",
    });
    const res = await authedRequest(app.server).put(`/sessions/${session.id}`);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Team");
    expect(res.body.agentIds).toEqual(["a1"]);
    await app.close();
  });

  it("M32：DELETE 不存在 session 返回 404（不再恒 204）", async () => {
    const app = await makeApp();
    const res = await authedRequest(app.server).delete("/sessions/nope");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Session not found");
    await app.close();
  });

  it("rejects session creation with invalid agent id", async () => {
    const app = await makeApp();
    const res = await authedRequest(app.server).post("/sessions").send({ name: "Team", agentIds: ["a1", "bad id!"] });
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
    const res = await authedRequest(app.server).put(`/sessions/${session.id}`).send({ name: "Crew", agentIds: ["a3"] });
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
    const res = await authedRequest(app.server).put(`/sessions/${session.id}`).send({ agentIds: ["a1", "bad id!"] });
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

    const res = await authedRequest(app.server).get(`/sessions/${session.id}/messages`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].id).toBe("m1");
    expect(res.body[0].agentId).toBeUndefined();
    expect(res.body[1].id).toBe("m2");
    // assistant 消息标注归属 Agent，user 消息不标注
    expect(res.body[1].agentId).toBe("a2");
    await app.close();
  });

  it("dedupes user messages stored in every member repository", async () => {
    const app = await makeApp();
    const session = await context.sessionRepository.create({
      name: "Team",
      agentIds: ["a1", "a2"],
      type: "group",
    });

    // 与 session-handler 行为一致：同一条用户消息写入每个成员的仓库
    const userMsg: ChatMessageRecord = {
      id: "u1",
      sessionId: session.id,
      role: "user",
      content: [{ type: "text", text: "hi all" }],
      createdAt: new Date().toISOString(),
    };
    await context.getMessageRepository("a1").append(userMsg);
    await context.getMessageRepository("a2").append({ ...userMsg });

    const res = await authedRequest(app.server).get(`/sessions/${session.id}/messages`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe("u1");
    await app.close();
  });

  it("limit applies to the merged total, keeping the newest messages", async () => {
    const app = await makeApp();
    const session = await context.sessionRepository.create({
      name: "Team",
      agentIds: ["a1", "a2"],
      type: "group",
    });

    const mk = (id: string, ms: number, role: "user" | "assistant"): ChatMessageRecord => ({
      id,
      sessionId: session.id,
      role,
      content: [{ type: "text", text: id }],
      createdAt: new Date(ms).toISOString(),
    });
    await context.getMessageRepository("a1").append(mk("old", 1000, "user"));
    await context.getMessageRepository("a2").append(mk("new", 3000, "assistant"));
    await context.getMessageRepository("a2").append(mk("mid", 2000, "assistant"));

    const res = await authedRequest(app.server).get(`/sessions/${session.id}/messages?limit=2`);
    expect(res.status).toBe(200);
    // 总量截断（非 per-agent 各 2 条），保留最新的两条
    expect(res.body.map((m: { id: string }) => m.id)).toEqual(["mid", "new"]);
    await app.close();
  });

  it("A5：limit=0/'abc'/-5 回缺省 100，超上限封顶 500（slice(-0) 全量路径消除）", async () => {
    const app = await makeApp();
    const session = await context.sessionRepository.create({
      name: "Big",
      agentIds: ["a1"],
      type: "group",
    });
    const repo = context.getMessageRepository("a1");
    for (let i = 0; i < 520; i++) {
      await repo.append({
        id: `m${i}`,
        sessionId: session.id,
        role: "user",
        content: [{ type: "text", text: `m${i}` }],
        createdAt: new Date(1000 + i).toISOString(),
      });
    }
    for (const bad of ["0", "abc", "-5"]) {
      const res = await authedRequest(app.server).get(
        `/sessions/${session.id}/messages?limit=${bad}`,
      );
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(100);
      expect(res.body).not.toHaveLength(520);
    }
    const capped = await authedRequest(app.server).get(
      `/sessions/${session.id}/messages?limit=99999`,
    );
    expect(capped.status).toBe(200);
    expect(capped.body).toHaveLength(500);
    await app.close();
  });
});
