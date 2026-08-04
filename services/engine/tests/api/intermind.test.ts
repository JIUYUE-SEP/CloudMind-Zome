import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { authedRequest } from "../helpers/auth.js";
import fsp from "node:fs/promises";
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
import { IntermindService } from "../../src/intermind/service.js";
import { restoreDataDir } from "../helpers/env.js";
import type { ApiContext } from "../../src/api/context.js";
import type { FastifyInstance } from "fastify";

let tmpDir: string;
let originalDataDir: string | undefined;
let app: FastifyInstance;
let intermindService: IntermindService;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "intermind-api-test-"));
  originalDataDir = process.env.CLOUDMIND_DATA_DIR;
  process.env.CLOUDMIND_DATA_DIR = tmpDir;

  const agentRepository = new AgentRepository();
  await agentRepository.save("a1", {
    id: "a1",
    name: "甲",
    persona: "",
    skills: [],
    tools: [],
    model: "mock",
  });
  await agentRepository.save("a2", {
    id: "a2",
    name: "乙",
    persona: "",
    skills: [],
    tools: [],
    model: "mock",
  });
  intermindService = new IntermindService({
    getAgentConfig: (id) => agentRepository.get(id),
    getMessageRepository: (id) => new MessageRepository(id),
    getAgentWorker: async () => undefined,
  });

  const context: ApiContext = {
    agentRepository,
    getMessageRepository: (id) => new MessageRepository(id),
    getMemoryRepository: (id) => new MemoryRepository(id),
    getActionRepository: (id) => new ActionRepository(id),
    getLLMCallRepository: (id) => new LLMCallRepository(id),
    configRepository: new ConfigRepository(),
    sessionRepository: new SessionRepository(),
    blueprintRepository: new BlueprintRepository(),
    getAgentWorker: async () => undefined,
    intermindService,
  };
  app = await createServer(context);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  restoreDataDir(originalDataDir);
  await fsp.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("Intermind REST", () => {
  it("GET /agents/:id/intermind：对端 + 最后消息时间 + 条数", async () => {
    await intermindService.send("a1", "a2", "第一条", { wake: false });
    await intermindService.send("a1", "a2", "第二条", { wake: false });

    const res = await authedRequest(app.server).get("/agents/a2/intermind");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ peer: "a1", count: 2 });
    expect(typeof res.body[0].lastMessageAt).toBe("string");
  });

  it("GET /agents/:id/intermind/:peerId/messages：来往消息带发送方归属", async () => {
    await intermindService.send("a1", "a2", "你好", { wake: false });
    await intermindService.send("a2", "a1", "回信", { wake: false });

    const res = await authedRequest(app.server).get("/agents/a1/intermind/a2/messages");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toMatchObject({
      sessionId: "intermind:a2",
      agentId: "a1",
      content: [{ type: "text", text: "你好" }],
    });
    expect(res.body[1]).toMatchObject({ agentId: "a2" });
  });

  it("分页：limit 生效且 clamp（上限 200、下限 1），before 游标生效", async () => {
    for (let i = 1; i <= 3; i++) {
      await intermindService.send("a1", "a2", `第${i}条`, { wake: false });
    }
    const repo = new MessageRepository("a2");
    const all = await repo.listBySession("intermind:a1");

    const limited = await authedRequest(app.server).get("/agents/a2/intermind/a1/messages?limit=1");
    expect(limited.status).toBe(200);
    expect(limited.body.map((m: { content: { text: string }[] }) => m.content[0].text)).toEqual([
      "第3条",
    ]);

    const clamped = await authedRequest(app.server).get("/agents/a2/intermind/a1/messages?limit=99999");
    expect(clamped.status).toBe(200);
    expect(clamped.body).toHaveLength(3);

    const before = await authedRequest(app.server).get(
      `/agents/a2/intermind/a1/messages?before=${encodeURIComponent(all[2]!.id)}`,
    );
    expect(before.body.map((m: { content: { text: string }[] }) => m.content[0].text)).toEqual([
      "第1条",
      "第2条",
    ]);

    const invalid = await authedRequest(app.server).get(
      "/agents/a2/intermind/a1/messages?before=no-such-id",
    );
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toContain("Invalid before cursor");
  });

  it("会话列表与 messages 同口径：非 agent 列表的对端（历史/已删除）也列出且可读", async () => {
    await new MessageRepository("a2").append({
      id: "m-ghost",
      sessionId: "intermind:ghost",
      role: "user",
      content: [{ type: "text", text: "旧信" }],
      agentId: "ghost",
      createdAt: new Date().toISOString(),
    });

    const list = await authedRequest(app.server).get("/agents/a2/intermind");
    expect(list.status).toBe(200);
    expect(list.body.map((s: { peer: string }) => s.peer)).toContain("ghost");

    const msgs = await authedRequest(app.server).get("/agents/a2/intermind/ghost/messages");
    expect(msgs.status).toBe(200);
    expect(msgs.body).toHaveLength(1);
  });

  it("非法 agent id → 400；未知 agent → 404；无消息的对端 → 空列表", async () => {
    const bad = await authedRequest(app.server).get("/agents/bad%20id/intermind");
    expect(bad.status).toBe(400);

    const missing = await authedRequest(app.server).get("/agents/ghost/intermind");
    expect(missing.status).toBe(404);

    const empty = await authedRequest(app.server).get("/agents/a1/intermind/a2/messages");
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual([]);
  });
});
