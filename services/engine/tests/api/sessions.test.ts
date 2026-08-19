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

  it("PUT 显式空 agentIds → 400，不破坏 POST 的非空成员不变量", async () => {
    const app = await makeApp();
    const session = await context.sessionRepository.create({
      name: "Team",
      agentIds: ["a1", "a2"],
      type: "group",
    });
    const res = await authedRequest(app.server).put(`/sessions/${session.id}`).send({ agentIds: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("agentIds must not be empty");
    // 原成员保持不变
    const after = await context.sessionRepository.get(session.id);
    expect(after?.agentIds).toEqual(["a1", "a2"]);
    await app.close();
  });

  it("POST type 白名单（对齐 shared Session 类型）：非法 400，group/intermind 放行", async () => {
    const app = await makeApp();
    const bad = await authedRequest(app.server)
      .post("/sessions")
      .send({ name: "T", agentIds: ["a1"], type: "webrtc" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("type");

    const group = await authedRequest(app.server)
      .post("/sessions")
      .send({ name: "G", agentIds: ["a1"], type: "group" });
    expect(group.status).toBe(200);
    expect(group.body.type).toBe("group");

    const intermind = await authedRequest(app.server)
      .post("/sessions")
      .send({ name: "I", agentIds: ["a1"], type: "intermind" });
    expect(intermind.status).toBe(200);
    expect(intermind.body.type).toBe("intermind");
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

  // before 分页共用夹具：u1 为复制进两成员仓库的 user 消息；r1/late1 只在 a1，
  // r2/late2 只在 a2（assistant 消息只入所属成员仓库，与 session-handler 一致）。
  // createdAt 轴：u1(1000) < r1(2000) < r2(3000) < late1(5000) < late2(6000)
  async function seedBeforeFixture(sessionId: string) {
    const mk = (id: string, ms: number, role: "user" | "assistant"): ChatMessageRecord => ({
      id,
      sessionId,
      role,
      content: [{ type: "text", text: id }],
      createdAt: new Date(ms).toISOString(),
    });
    const a1 = context.getMessageRepository("a1");
    const a2 = context.getMessageRepository("a2");
    await a1.append(mk("u1", 1000, "user"));
    await a2.append(mk("u1", 1000, "user"));
    await a1.append(mk("r1", 2000, "assistant"));
    await a2.append(mk("r2", 3000, "assistant"));
    await a1.append(mk("late1", 5000, "assistant"));
    await a2.append(mk("late2", 6000, "assistant"));
  }

  it("before 分页：assistant 游标只在 a1，跨成员合并后只含早于游标的消息", async () => {
    const app = await makeApp();
    const session = await context.sessionRepository.create({
      name: "Team",
      agentIds: ["a1", "a2"],
      type: "group",
    });
    await seedBeforeFixture(session.id);

    const res = await authedRequest(app.server).get(
      `/sessions/${session.id}/messages?before=r1`,
    );
    expect(res.status).toBe(200);
    // a2 的 r2（t=3000）虽在 a2 尾部窗口内，但晚于游标 r1（t=2000），被 createdAt 过滤
    expect(res.body.map((m: { id: string }) => m.id)).toEqual(["u1"]);
    await app.close();
  });

  it("before+limit：截取「早于游标」的尾部 limit 条，游标本身不含", async () => {
    const app = await makeApp();
    const session = await context.sessionRepository.create({
      name: "Team",
      agentIds: ["a1", "a2"],
      type: "group",
    });
    await seedBeforeFixture(session.id);

    // 游标前一页 = [u1, r1, r2, late1]，limit=2 取尾部
    const res = await authedRequest(app.server).get(
      `/sessions/${session.id}/messages?before=late2&limit=2`,
    );
    expect(res.status).toBe(200);
    expect(res.body.map((m: { id: string }) => m.id)).toEqual(["r2", "late1"]);

    // 不限 limit：游标前整页（游标本身不含）
    const full = await authedRequest(app.server).get(
      `/sessions/${session.id}/messages?before=late2`,
    );
    expect(full.status).toBe(200);
    expect(full.body.map((m: { id: string }) => m.id)).toEqual(["u1", "r1", "r2", "late1"]);
    await app.close();
  });

  it("before 游标命中首条（user 消息，两成员仓库都有）返回空页", async () => {
    const app = await makeApp();
    const session = await context.sessionRepository.create({
      name: "Team",
      agentIds: ["a1", "a2"],
      type: "group",
    });
    await seedBeforeFixture(session.id);

    const res = await authedRequest(app.server).get(
      `/sessions/${session.id}/messages?before=u1`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    await app.close();
  });

  it("before 游标不存在于任何成员时按无游标处理（与私聊端点同口径）", async () => {
    const app = await makeApp();
    const session = await context.sessionRepository.create({
      name: "Team",
      agentIds: ["a1", "a2"],
      type: "group",
    });
    await seedBeforeFixture(session.id);

    const res = await authedRequest(app.server).get(
      `/sessions/${session.id}/messages?before=no-such-id`,
    );
    expect(res.status).toBe(200);
    // 无游标语义 = 现状：合并去重后的尾部 limit 条（此处全量 5 条）
    expect(res.body.map((m: { id: string }) => m.id)).toEqual(["u1", "r1", "r2", "late1", "late2"]);
    await app.close();
  });

  it("跨热存储+归档读：归档层的消息能被列出（加载更早翻进归档层）", async () => {
    const app = await makeApp();
    const session = await context.sessionRepository.create({
      name: "Team",
      agentIds: ["a1", "a2"],
      type: "group",
    });
    await seedBeforeFixture(session.id);
    // u1/r1 在 a1 移入归档层（话题压缩后的真实形态）；a2 仓库不动
    // （u1 副本仍在 a2 热存储）——r1 从此只存在于 a1 归档
    await context.getMessageRepository("a1").archiveAndRemove(["u1", "r1"]);

    const res = await authedRequest(app.server).get(`/sessions/${session.id}/messages`);
    expect(res.status).toBe(200);
    // r1 只能来自 a1 归档层；u1 归档/热各一份去重后一条
    expect(res.body.map((m: { id: string }) => m.id)).toEqual(["u1", "r1", "r2", "late1", "late2"]);
    await app.close();
  });

  it("before 游标只在归档层：预查跨存储命中，页内容正确", async () => {
    const app = await makeApp();
    const session = await context.sessionRepository.create({
      name: "Team",
      agentIds: ["a1", "a2"],
      type: "group",
    });
    await seedBeforeFixture(session.id);
    await context.getMessageRepository("a1").archiveAndRemove(["u1", "r1"]);

    const res = await authedRequest(app.server).get(
      `/sessions/${session.id}/messages?before=r1`,
    );
    expect(res.status).toBe(200);
    // 游标 r1 只存在于 a1 归档层：预查 getByIds 不命中、getArchivedByIds 命中
    expect(res.body.map((m: { id: string }) => m.id)).toEqual(["u1"]);
    await app.close();
  });

  it("before 预查按 sessionId 过滤：其他会话的同 id 消息不污染游标", async () => {
    const app = await makeApp();
    const session = await context.sessionRepository.create({
      name: "Team",
      agentIds: ["a1", "a2"],
      type: "group",
    });
    await seedBeforeFixture(session.id);
    // 另一会话的同 id 消息（createdAt 更晚）：若预查不按 sessionId 过滤，
    // 游标 r1 会错拿 t=9999，本页会被错误放大为全量
    await context.getMessageRepository("a1").append({
      id: "r1",
      sessionId: "other-session",
      role: "assistant",
      content: [{ type: "text", text: "other" }],
      createdAt: new Date(9999).toISOString(),
    });

    const res = await authedRequest(app.server).get(
      `/sessions/${session.id}/messages?before=r1`,
    );
    expect(res.status).toBe(200);
    expect(res.body.map((m: { id: string }) => m.id)).toEqual(["u1"]);
    await app.close();
  });
});
