/**
 * 换班移交控制面 REST：
 * ① GET /handoff 查询（agent/session 过滤）；
 * ② DELETE /handoff/:id 手动打断（active → aborted/manual）；
 * ③ 404 / 鉴权路径不泄露。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
import { HandoffManager } from "../../src/handoff/manager.js";
import { HandoffStateStore } from "../../src/handoff/state.js";
import { HandoffLoopRegistry } from "../../src/handoff/registry.js";
import type { HandoffResumeLoop } from "../../src/handoff/resume-loop.js";
import type { HandoffBookInfo } from "../../src/handoff/types.js";
import type { ApiContext } from "../../src/api/context.js";
import type { FastifyInstance } from "fastify";
import { authedRequest } from "../helpers/auth.js";
import { restoreDataDir } from "../helpers/env.js";

function bookInfo(overrides: Partial<HandoffBookInfo> = {}): HandoffBookInfo {
  return {
    agentId: "a1",
    sessionId: "s1",
    reason: "watermark",
    shift: 1,
    maxShifts: 3,
    used: 950,
    window: 1000,
    bookMessageId: "msg_book",
    bookText: "[交接书] 换班移交（第 1/3 棒）",
    ...overrides,
  };
}

describe("Handoff API", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let originalDataDir: string | undefined;
  let manager: HandoffManager;
  let context: ApiContext;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "handoff-api-test-"));
    originalDataDir = process.env.CLOUDMIND_DATA_DIR;
    process.env.CLOUDMIND_DATA_DIR = tmpDir;
    manager = new HandoffManager({ store: new HandoffStateStore(path.join(tmpDir, "handoff-state.json")) });
    const handoffLoops = new HandoffLoopRegistry();
    context = {
      agentRepository: new AgentRepository(),
      getMessageRepository: (id: string) => new MessageRepository(id),
      getMemoryRepository: (id: string) => new MemoryRepository(id),
      getActionRepository: (id: string) => new ActionRepository(id),
      getLLMCallRepository: (id: string) => new LLMCallRepository(id),
      configRepository: new ConfigRepository(),
      sessionRepository: new SessionRepository(),
      blueprintRepository: new BlueprintRepository(),
      getAgentWorker: async () => undefined,
      handoffManager: manager,
      handoffLoops,
    };
    app = await createServer(context);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    restoreDataDir(originalDataDir);
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("GET /handoff：查询全部与 agent/session 过滤", async () => {
    await manager.record(bookInfo());
    await manager.record(bookInfo({ agentId: "a2", sessionId: "s2", shift: 2 }));

    const all = await authedRequest(app.server).get("/handoff");
    expect(all.status).toBe(200);
    expect(all.body).toHaveLength(2);

    const filtered = await authedRequest(app.server).get("/handoff?agentId=a1&sessionId=s1");
    expect(filtered.status).toBe(200);
    expect(filtered.body).toHaveLength(1);
    expect(filtered.body[0]).toMatchObject({
      id: "ho_a1_s1",
      status: "pending",
      shift: 1,
      maxShifts: 3,
      bookMessageId: "msg_book",
    });
  });

  it("DELETE /handoff/:id：活跃条目标 aborted（manual）；未知 404", async () => {
    const record = await manager.record(bookInfo());
    await manager.markStatus(record.id, "scheduled");

    const res = await authedRequest(app.server).delete(`/handoff/${record.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "aborted", abortReason: "manual" });

    const missing = await authedRequest(app.server).delete("/handoff/ho_ghost");
    expect(missing.status).toBe(404);
  });

  it("DELETE /handoff/:id：running 期经 loop 注册表 cancel 在途 job（P1-1）", async () => {
    const record = await manager.record(bookInfo());
    await manager.markStatus(record.id, "scheduled");
    await manager.markStatus(record.id, "running");

    const cancel = vi.fn(async () => {});
    const registry = context.handoffLoops!;
    registry.register("a1", "s1", { cancel } as unknown as HandoffResumeLoop);

    const res = await authedRequest(app.server).delete(`/handoff/${record.id}`);
    expect(res.status).toBe(200);
    expect(cancel).toHaveBeenCalledWith("a1", "s1", "manual", { global: true });
    expect(res.body).toMatchObject({ status: "aborted", abortReason: "manual" });
  });

  it("GET /handoff：bookText 摘要化（>500 截断 + truncated 标记）；GET /handoff/:id/book 全文", async () => {
    const longBook = `[交接书] ${"长".repeat(600)}`;
    const record = await manager.record(bookInfo({ bookText: longBook }));
    await manager.record(bookInfo({ agentId: "a2", sessionId: "s2" }));

    // 长交接书：list 只带 500 字符摘要 + 截断标记
    const list = await authedRequest(app.server).get("/handoff?agentId=a1&sessionId=s1");
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].bookText).toHaveLength(500);
    expect(list.body[0].bookTextTruncated).toBe(true);
    expect(longBook.startsWith(list.body[0].bookText)).toBe(true);

    // 短交接书：不截断、原文返回
    const short = await authedRequest(app.server).get("/handoff?agentId=a2&sessionId=s2");
    expect(short.body[0].bookText).toBe("[交接书] 换班移交（第 1/3 棒）");
    expect(short.body[0].bookTextTruncated).toBe(false);

    // 全文端点：完整 bookText 原样返回；未知 id 404
    const full = await authedRequest(app.server).get(`/handoff/${record.id}/book`);
    expect(full.status).toBe(200);
    expect(full.body).toEqual({ id: record.id, bookText: longBook });

    const missing = await authedRequest(app.server).get("/handoff/ho_ghost/book");
    expect(missing.status).toBe(404);
  });

  it("DELETE /handoff/:id：响应同样摘要化（对齐 D1 口径，不带交接书全文）", async () => {
    const longBook = `[交接书] ${"长".repeat(600)}`;
    const record = await manager.record(bookInfo({ bookText: longBook }));
    await manager.markStatus(record.id, "scheduled");

    // 长交接书：DELETE 响应只带 500 字符摘要 + 截断标记（同 list 口径）
    const res = await authedRequest(app.server).delete(`/handoff/${record.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "aborted", abortReason: "manual" });
    expect(res.body.bookText).toHaveLength(500);
    expect(res.body.bookTextTruncated).toBe(true);
    expect(longBook.startsWith(res.body.bookText)).toBe(true);

    // 短交接书：不截断、原文返回
    const short = await manager.record(bookInfo({ agentId: "a2", sessionId: "s2" }));
    await manager.markStatus(short.id, "scheduled");
    const shortRes = await authedRequest(app.server).delete(`/handoff/${short.id}`);
    expect(shortRes.status).toBe(200);
    expect(shortRes.body.bookText).toBe("[交接书] 换班移交（第 1/3 棒）");
    expect(shortRes.body.bookTextTruncated).toBe(false);
  });
});
