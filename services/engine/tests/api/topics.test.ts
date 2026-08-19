import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
import { compressedDir, writeCompressedTopic } from "../../src/memory/topic/store.js";
import type { CompressedTopic } from "../../src/memory/topic/types.js";
import type { ApiContext } from "../../src/api/context.js";
import type { ChatMessageRecord } from "@mindcloud/shared";
import type { FastifyInstance } from "fastify";
import { restoreDataDir } from "../helpers/env.js";

const AGENT = "a1";

function makeTopic(overrides: Partial<CompressedTopic> = {}): CompressedTopic {
  return {
    topicId: `tp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    label: "前端状态管理",
    summary: "话题主题：前端状态管理\n关键结论：\n- 决定用 Zustand",
    keyPoints: ["决定用 Zustand", "持久化用 localStorage"],
    msgIds: ["m1", "m2"],
    msgCount: 2,
    importance: "normal",
    sourceId: "s1",
    sourceName: "与指挥官的私聊",
    compressedAt: "2026-07-21T10:00:00.000Z",
    startedAt: "2026-07-21T09:00:00.000Z",
    endedAt: "2026-07-21T09:30:00.000Z",
    usedSkills: ["code-review"],
    ...overrides,
  };
}

function makeRecord(id: string, createdAt: string, sessionId = "s1"): ChatMessageRecord {
  return {
    id,
    sessionId,
    role: "user",
    content: [{ type: "text", text: `内容 ${id}` }],
    createdAt,
  };
}

async function buildContext(): Promise<{
  context: ApiContext;
  reindexMock: ReturnType<typeof vi.fn>;
  cleanup: () => Promise<void>;
}> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "topics-api-test-"));
  const originalDataDir = process.env.CLOUDMIND_DATA_DIR;
  process.env.CLOUDMIND_DATA_DIR = tmpDir;

  const agentRepository = new AgentRepository();
  await agentRepository.save(AGENT, {
    id: AGENT,
    name: "Test",
    persona: "",
    model: "mock",
    skills: [],
    tools: [],
  });

  const reindexMock = vi.fn();
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
    reindexMessages: reindexMock,
  };

  return {
    context,
    reindexMock,
    cleanup: async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
      restoreDataDir(originalDataDir);
    },
  };
}

describe("Topics API（P4-d 审计接口）", () => {
  let context: ApiContext;
  let reindexMock: ReturnType<typeof vi.fn>;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const built = await buildContext();
    context = built.context;
    reindexMock = built.reindexMock;
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

  async function topicFileExists(topicId: string): Promise<boolean> {
    return fs
      .stat(path.join(compressedDir(AGENT), `${topicId}.md`))
      .then(() => true)
      .catch(() => false);
  }

  describe("GET /agents/:id/topics（列表）", () => {
    it("多档按压缩时间倒序，字段齐全", async () => {
      // 故意让文件名序与 compressedAt 序相反，证明排序字段是 compressedAt
      await writeCompressedTopic(AGENT, makeTopic({
        topicId: "tp_3000_cccc", label: "旧压缩", compressedAt: "2026-07-01T10:00:00.000Z",
      }));
      await writeCompressedTopic(AGENT, makeTopic({
        topicId: "tp_1000_aaaa", label: "新压缩", compressedAt: "2026-07-21T10:00:00.000Z",
        importance: "high", sourceName: "群聊",
      }));
      await writeCompressedTopic(AGENT, makeTopic({
        topicId: "tp_2000_bbbb", label: "中间压缩", compressedAt: "2026-07-15T10:00:00.000Z",
      }));
      const app = await makeApp();
      const res = await authedRequest(app.server).get(`/agents/${AGENT}/topics`);
      expect(res.status).toBe(200);
      expect(res.body.map((t: { topicId: string }) => t.topicId)).toEqual([
        "tp_1000_aaaa", "tp_2000_bbbb", "tp_3000_cccc",
      ]);
      const first = res.body[0];
      expect(Object.keys(first).sort()).toEqual([
        "compressedAt", "importance", "label", "msgCount", "sourceId", "sourceName", "topicId",
      ]);
      expect(first).toMatchObject({
        label: "新压缩", importance: "high", sourceId: "s1",
        sourceName: "群聊", compressedAt: "2026-07-21T10:00:00.000Z", msgCount: 2,
      });
      await app.close();
    });

    it("limit/offset 分页；非法参数 clamp（缺省 100 上限 500）", async () => {
      for (const [i, id] of ["tp_1000_a", "tp_2000_b", "tp_3000_c"].entries()) {
        await writeCompressedTopic(AGENT, makeTopic({
          topicId: id, compressedAt: `2026-07-0${i + 1}T10:00:00.000Z`,
        }));
      }
      const app = await makeApp();
      const page1 = await authedRequest(app.server).get(`/agents/${AGENT}/topics?limit=2`);
      expect(page1.body).toHaveLength(2);
      expect(page1.body[0].topicId).toBe("tp_3000_c");
      const page2 = await authedRequest(app.server).get(`/agents/${AGENT}/topics?limit=2&offset=2`);
      expect(page2.body).toHaveLength(1);
      expect(page2.body[0].topicId).toBe("tp_1000_a");
      for (const bad of ["0", "abc", "-5"]) {
        const res = await authedRequest(app.server).get(`/agents/${AGENT}/topics?limit=${bad}`);
        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(3);
      }
      const offsetBad = await authedRequest(app.server).get(`/agents/${AGENT}/topics?limit=1&offset=abc`);
      expect(offsetBad.body[0].topicId).toBe("tp_3000_c");
      await app.close();
    });

    it("损坏档 warn 跳过不中断（读失败的档不进列表）", async () => {
      await writeCompressedTopic(AGENT, makeTopic({ topicId: "tp_1000_good", label: "好档" }));
      // 名为 .md 的目录：readFile 必失败（EISDIR），按损坏档跳过
      await fs.mkdir(path.join(compressedDir(AGENT), "tp_9000_bad.md"), { recursive: true });
      const app = await makeApp();
      const res = await authedRequest(app.server).get(`/agents/${AGENT}/topics`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].topicId).toBe("tp_1000_good");
      await app.close();
    });

    it("高版本档显式上抛（500），不按坏档静默跳过", async () => {
      await fs.mkdir(compressedDir(AGENT), { recursive: true });
      await fs.writeFile(
        path.join(compressedDir(AGENT), "tp_1000_future.md"),
        "---\nschema: 999\ntopic_id: tp_1000_future\ncompressed_at: 2026-07-01T10:00:00.000Z\n---\n\n## Summary\n\nx\n",
      );
      const app = await makeApp();
      const res = await authedRequest(app.server).get(`/agents/${AGENT}/topics`);
      expect(res.status).toBe(500);
      await app.close();
    });

    it("agent 不存在 404；非法 agent id 400；无档 agent 空列表", async () => {
      const app = await makeApp();
      const ghost = await authedRequest(app.server).get("/agents/ghost/topics");
      expect(ghost.status).toBe(404);
      const invalid = await authedRequest(app.server).get("/agents/bad!/topics");
      expect(invalid.status).toBe(400);
      const empty = await authedRequest(app.server).get(`/agents/${AGENT}/topics`);
      expect(empty.status).toBe(200);
      expect(empty.body).toEqual([]);
      await app.close();
    });
  });

  describe("GET /agents/:id/topics/:topicId（单档全文）", () => {
    it("frontmatter 各字段 + Summary/Key Points/msgIds 齐全", async () => {
      const topic = makeTopic({ topicId: "tp_1000_full", importance: "high" });
      await writeCompressedTopic(AGENT, topic);
      const app = await makeApp();
      const res = await authedRequest(app.server).get(`/agents/${AGENT}/topics/tp_1000_full`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        topicId: "tp_1000_full",
        label: "前端状态管理",
        importance: "high",
        sourceId: "s1",
        sourceName: "与指挥官的私聊",
        compressedAt: "2026-07-21T10:00:00.000Z",
        startedAt: "2026-07-21T09:00:00.000Z",
        endedAt: "2026-07-21T09:30:00.000Z",
        msgCount: 2,
        usedSkills: ["code-review"],
        summary: "话题主题：前端状态管理\n关键结论：\n- 决定用 Zustand",
        keyPoints: ["决定用 Zustand", "持久化用 localStorage"],
        msgIds: ["m1", "m2"],
      });
      await app.close();
    });

    it("topic 不存在 404；损坏档 404；agent 不存在 404；非法 id 400（防路径穿越）", async () => {
      await writeCompressedTopic(AGENT, makeTopic({ topicId: "tp_1000_ok" }));
      // 无 frontmatter 的损坏档：解析不出详情，按 404（与 recall 取档同口径）
      await fs.writeFile(path.join(compressedDir(AGENT), "tp_2000_corrupt.md"), "垃圾内容");
      const app = await makeApp();
      const missing = await authedRequest(app.server).get(`/agents/${AGENT}/topics/tp_9999_none`);
      expect(missing.status).toBe(404);
      const corrupt = await authedRequest(app.server).get(`/agents/${AGENT}/topics/tp_2000_corrupt`);
      expect(corrupt.status).toBe(404);
      const ghost = await authedRequest(app.server).get("/agents/ghost/topics/tp_1000_ok");
      expect(ghost.status).toBe(404);
      const invalidTopic = await authedRequest(app.server).get(`/agents/${AGENT}/topics/bad!id`);
      expect(invalidTopic.status).toBe(400);
      const traversal = await authedRequest(app.server).get(`/agents/${AGENT}/topics/..%2F..%2Fetc`);
      expect(traversal.status).toBe(400);
      const invalidAgent = await authedRequest(app.server).get("/agents/bad!/topics/tp_1000_ok");
      expect(invalidAgent.status).toBe(400);
      await app.close();
    });
  });

  describe("POST /agents/:id/topics/:topicId/restore（恢复即删档）", () => {
    async function seedArchived(ids: string[]): Promise<ChatMessageRecord[]> {
      const repo = context.getMessageRepository(AGENT);
      const records = ids.map((id, i) =>
        makeRecord(id, new Date(1_000_000 + i * 1000).toISOString()));
      for (const r of records) await repo.append(r);
      await repo.archiveAndRemove(ids);
      return records;
    }

    it("恢复原文回热存储 + 档已删 + reindex 被调", async () => {
      const records = await seedArchived(["m1", "m2", "m3"]);
      const topic = makeTopic({ topicId: "tp_1000_r1", msgIds: ["m1", "m2", "m3"], msgCount: 3 });
      await writeCompressedTopic(AGENT, topic);
      expect(await topicFileExists("tp_1000_r1")).toBe(true);

      const app = await makeApp();
      const res = await authedRequest(app.server).post(`/agents/${AGENT}/topics/tp_1000_r1/restore`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ restored: 3, missing: 0 });

      // 档已删；原文回热存储（内容逐字节一致）；L3 最近窗口可见（恢复既定语义）
      expect(await topicFileExists("tp_1000_r1")).toBe(false);
      const repo = context.getMessageRepository(AGENT);
      const restored = await repo.getByIds(["m1", "m2", "m3"]);
      expect(restored).toHaveLength(3);
      expect(restored).toEqual(records);
      const sessionView = await repo.listBySession("s1");
      expect(sessionView.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
      // reindex：归档全集（含防重跳过的也在此集合语义内）重新索引
      expect(reindexMock).toHaveBeenCalledTimes(1);
      const [agentArg, recordsArg] = reindexMock.mock.calls[0]!;
      expect(agentArg).toBe(AGENT);
      expect((recordsArg as ChatMessageRecord[]).map((m) => m.id).sort()).toEqual(["m1", "m2", "m3"]);
      await app.close();
    });

    it("幂等：重复 restore 已删档 → 404", async () => {
      await seedArchived(["m1", "m2"]);
      await writeCompressedTopic(AGENT, makeTopic({ topicId: "tp_1000_r2" }));
      const app = await makeApp();
      const first = await authedRequest(app.server).post(`/agents/${AGENT}/topics/tp_1000_r2/restore`);
      expect(first.status).toBe(200);
      const second = await authedRequest(app.server).post(`/agents/${AGENT}/topics/tp_1000_r2/restore`);
      expect(second.status).toBe(404);
      await app.close();
    });

    it("归档部分缺行：跳过并计数 missing，档仍删", async () => {
      await seedArchived(["m1", "m2"]);
      await writeCompressedTopic(AGENT, makeTopic({
        topicId: "tp_1000_r3", msgIds: ["m1", "m2", "m3"], msgCount: 3,
      }));
      const app = await makeApp();
      const res = await authedRequest(app.server).post(`/agents/${AGENT}/topics/tp_1000_r3/restore`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ restored: 2, missing: 1 });
      expect(await topicFileExists("tp_1000_r3")).toBe(false);
      const restored = await context.getMessageRepository(AGENT).getByIds(["m1", "m2", "m3"]);
      expect(restored.map((m) => m.id)).toEqual(["m1", "m2"]);
      await app.close();
    });

    it("归档全缺：409 不动档、不 reindex", async () => {
      await writeCompressedTopic(AGENT, makeTopic({
        topicId: "tp_1000_r4", msgIds: ["x1", "x2"], msgCount: 2,
      }));
      const app = await makeApp();
      const res = await authedRequest(app.server).post(`/agents/${AGENT}/topics/tp_1000_r4/restore`);
      expect(res.status).toBe(409);
      expect(res.body.missing).toBe(2);
      expect(await topicFileExists("tp_1000_r4")).toBe(true);
      expect(reindexMock).not.toHaveBeenCalled();
      await app.close();
    });

    it("防重：已在热存储的 id 跳过，不产生重复行", async () => {
      const records = await seedArchived(["m1", "m2"]);
      // 模拟 m1 已在热存储（上次部分恢复/并发写回）
      const repo = context.getMessageRepository(AGENT);
      await repo.append(records[0]!);
      await writeCompressedTopic(AGENT, makeTopic({ topicId: "tp_1000_r5" }));
      const app = await makeApp();
      const res = await authedRequest(app.server).post(`/agents/${AGENT}/topics/tp_1000_r5/restore`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ restored: 1, missing: 0 });
      expect(await repo.getByIds(["m1"])).toHaveLength(1);
      expect(await repo.getByIds(["m1", "m2"])).toHaveLength(2);
      await app.close();
    });

    it("agent 不存在 404；非法 id 400", async () => {
      await writeCompressedTopic(AGENT, makeTopic({ topicId: "tp_1000_r6" }));
      const app = await makeApp();
      const ghost = await authedRequest(app.server).post("/agents/ghost/topics/tp_1000_r6/restore");
      expect(ghost.status).toBe(404);
      const invalidTopic = await authedRequest(app.server).post(`/agents/${AGENT}/topics/bad!id/restore`);
      expect(invalidTopic.status).toBe(400);
      const invalidAgent = await authedRequest(app.server).post("/agents/bad!/topics/tp_1000_r6/restore");
      expect(invalidAgent.status).toBe(400);
      // 校验失败不动档
      expect(await topicFileExists("tp_1000_r6")).toBe(true);
      await app.close();
    });
  });
});
