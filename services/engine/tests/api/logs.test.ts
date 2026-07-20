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
import { clearBufferedLogs } from "../../src/api/log-buffer.js";
import type { ApiContext } from "../../src/api/context.js";
import { restoreDataDir } from "../helpers/env.js";

async function buildContext(): Promise<{ context: ApiContext; cleanup: () => Promise<void> }> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "logs-api-test-"));
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

describe("Logs API", () => {
  let context: ApiContext;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    clearBufferedLogs();
    const built = await buildContext();
    context = built.context;
    cleanup = built.cleanup;
  });

  afterEach(async () => {
    await cleanup();
  });

  it("returns buffered request logs via GET /logs", async () => {
    const app = await createServer(context);
    await app.ready();

    // 触发一次请求，fastify 会打 "incoming request"/"request completed" 日志
    await request(app.server).get("/health");

    const res = await request(app.server).get("/logs");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    for (const entry of res.body) {
      expect(typeof entry.time).toBe("number");
      expect(typeof entry.level).toBe("number");
      expect(typeof entry.msg).toBe("string");
    }
    expect(res.body.some((e: { msg: string }) => e.msg === "incoming request")).toBe(true);
    await app.close();
  });

  it("captures warn/error level entries", async () => {
    const app = await createServer(context);
    await app.ready();

    app.log.warn("logs-api-warn-marker");
    app.log.error("logs-api-error-marker");

    const res = await request(app.server).get("/logs?limit=1000");
    expect(res.status).toBe(200);
    const warn = res.body.find((e: { msg: string }) => e.msg === "logs-api-warn-marker");
    const error = res.body.find((e: { msg: string }) => e.msg === "logs-api-error-marker");
    expect(warn?.level).toBe(40);
    expect(error?.level).toBe(50);
    await app.close();
  });
});
