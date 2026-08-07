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
import type { ChatMessageRecord } from "../../src/memory/repositories/types.js";
import type { FastifyInstance } from "fastify";
import { restoreDataDir } from "../helpers/env.js";

async function buildTestContext(): Promise<{ context: ApiContext; cleanup: () => Promise<void> }> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "chat-api-test-"));
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

describe("Chat API", () => {
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

  it("returns messages for a session", async () => {
    const app = await makeApp();
    const repo = context.getMessageRepository("agent-1");
    const msg: ChatMessageRecord = {
      id: "m1",
      sessionId: "s1",
      role: "user",
      content: [{ type: "text", text: "hi" }],
      createdAt: new Date().toISOString(),
    };
    await repo.append(msg);

    const res = await authedRequest(app.server).get("/chat/agent-1/messages?sessionId=s1");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe("m1");
    await app.close();
  });

  it("returns archived + hot messages as user-visible full history", async () => {
    const app = await makeApp();
    const repo = context.getMessageRepository("agent-1");
    const recAt = (id: string, createdAt: string): ChatMessageRecord => ({
      id,
      sessionId: "s1",
      role: "user",
      content: [{ type: "text", text: `msg ${id}` }],
      createdAt,
    });
    await repo.append(recAt("m1", "2026-08-01T00:00:00.000Z"));
    await repo.append(recAt("m2", "2026-08-02T00:00:00.000Z"));
    await repo.append(recAt("m3", "2026-08-03T00:00:00.000Z"));
    await repo.archiveAndRemove(["m1"]);

    const res = await authedRequest(app.server).get("/chat/agent-1/messages?sessionId=s1");
    expect(res.status).toBe(200);
    expect(res.body.map((m: { id: string }) => m.id)).toEqual(["m1", "m2", "m3"]);
    await app.close();
  });

  it("paginates across archive/hot boundary with limit and before", async () => {
    const app = await makeApp();
    const repo = context.getMessageRepository("agent-1");
    const recAt = (id: string, createdAt: string): ChatMessageRecord => ({
      id,
      sessionId: "s1",
      role: "user",
      content: [{ type: "text", text: `msg ${id}` }],
      createdAt,
    });
    for (let i = 1; i <= 5; i++) {
      await repo.append(recAt(`m${i}`, `2026-08-0${i}T00:00:00.000Z`));
    }
    await repo.archiveAndRemove(["m1", "m2", "m3"]);

    // limit 切在归档/热存储边界
    const tail = await authedRequest(app.server).get("/chat/agent-1/messages?sessionId=s1&limit=3");
    expect(tail.status).toBe(200);
    expect(tail.body.map((m: { id: string }) => m.id)).toEqual(["m3", "m4", "m5"]);

    // before 游标在热存储、窗口伸进归档
    const beforeHot = await authedRequest(app.server).get(
      "/chat/agent-1/messages?sessionId=s1&limit=3&before=m4",
    );
    expect(beforeHot.status).toBe(200);
    expect(beforeHot.body.map((m: { id: string }) => m.id)).toEqual(["m1", "m2", "m3"]);

    // before 游标命中归档：继续在归档里翻页
    const beforeArchived = await authedRequest(app.server).get(
      "/chat/agent-1/messages?sessionId=s1&limit=2&before=m3",
    );
    expect(beforeArchived.status).toBe(200);
    expect(beforeArchived.body.map((m: { id: string }) => m.id)).toEqual(["m1", "m2"]);
    await app.close();
  });

  it("requires sessionId", async () => {
    const app = await makeApp();
    const res = await authedRequest(app.server).get("/chat/agent-1/messages");
    expect(res.status).toBe(400);
    await app.close();
  });

  it("returns 400 for invalid agent id", async () => {
    const app = await makeApp();
    const res = await authedRequest(app.server).get("/chat/invalid!/messages?sessionId=s1");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid agent id");
    await app.close();
  });
});
