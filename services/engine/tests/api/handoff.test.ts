/**
 * 换班移交控制面 REST：
 * ① GET /handoff 查询（agent/session 过滤）；
 * ② DELETE /handoff/:id 手动打断（active → aborted/manual）；
 * ③ 404 / 鉴权路径不泄露。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
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

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "handoff-api-test-"));
    originalDataDir = process.env.CLOUDMIND_DATA_DIR;
    process.env.CLOUDMIND_DATA_DIR = tmpDir;
    manager = new HandoffManager({ store: new HandoffStateStore(path.join(tmpDir, "handoff-state.json")) });
    const context: ApiContext = {
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
});
