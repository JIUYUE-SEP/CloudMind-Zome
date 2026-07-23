import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { authedRequest } from "../helpers/auth.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "../../src/api/server.js";
import { AgentRepository } from "../../src/memory/repositories/agent.js";
import { MessageRepository } from "../../src/memory/repositories/message.js";
import { MemoryRepository } from "../../src/memory/repositories/memory.js";
import { ActionRepository } from "../../src/memory/repositories/action.js";
import { LLMCallRepository } from "../../src/memory/repositories/llm-call.js";
import { ConfigRepository } from "../../src/config/repository.js";
import { SessionRepository } from "../../src/conductor/repository.js";
import { BlueprintRepository } from "../../src/blueprint/repository.js";
import { BackgroundManager } from "../../src/subagent/background.js";
import type { ApiContext } from "../../src/api/context.js";
import type { FastifyInstance } from "fastify";
import type { AgentConfig } from "@mindcloud/shared";
import { restoreDataDir } from "../helpers/env.js";

const config: AgentConfig = { id: "a2", name: "A2", persona: "", model: "mock", skills: [], tools: [] };

async function buildContext(runAgent: () => Promise<string>): Promise<{
  context: ApiContext;
  backgroundManager: BackgroundManager;
  cleanup: () => Promise<void>;
}> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "subagents-api-test-"));
  const originalDataDir = process.env.CLOUDMIND_DATA_DIR;
  process.env.CLOUDMIND_DATA_DIR = tmpDir;

  const backgroundManager = new BackgroundManager({ runAgent });

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
    backgroundManager,
  };

  return {
    context,
    backgroundManager,
    cleanup: async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
      restoreDataDir(originalDataDir);
    },
  };
}

function makeTask(id: string) {
  return {
    id,
    parentAgentId: "a1",
    taskDescription: "do work",
    messages: [
      {
        id: randomUUID(),
        role: "user" as const,
        content: [{ type: "text" as const, text: "do work" }],
        createdAt: new Date().toISOString(),
      },
    ],
  };
}

describe("Subagents API", () => {
  let app: FastifyInstance;
  let backgroundManager: BackgroundManager;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const built = await buildContext(async () => "bg result");
    backgroundManager = built.backgroundManager;
    cleanup = built.cleanup;
    app = await createServer(built.context);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await cleanup();
  });

  it("lists background tasks and gets one by id", async () => {
    backgroundManager.register(makeTask("t1"), config, 60_000);
    await vi.waitFor(() => expect(backgroundManager.get("t1")?.status).toBe("completed"));

    const list = await authedRequest(app.server).get("/subagents/background");
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ taskId: "t1", status: "completed", output: "bg result" });

    const got = await authedRequest(app.server).get("/subagents/background/t1");
    expect(got.status).toBe(200);
    expect(got.body.parentAgentId).toBe("a1");
    expect(got.body.agentId).toBe("a2");
  });

  it("returns 404 for unknown task id", async () => {
    const res = await authedRequest(app.server).get("/subagents/background/nope");
    expect(res.status).toBe(404);
  });

  it("reflects failed status after runAgent rejects", async () => {
    await app.close();
    await cleanup();

    const built = await buildContext(async () => {
      throw new Error("bg boom");
    });
    backgroundManager = built.backgroundManager;
    cleanup = built.cleanup;
    app = await createServer(built.context);
    await app.ready();

    backgroundManager.register(makeTask("t2"), config, 60_000);
    await vi.waitFor(() => expect(backgroundManager.get("t2")?.status).toBe("failed"));

    const res = await authedRequest(app.server).get("/subagents/background/t2");
    expect(res.body.status).toBe("failed");
    expect(res.body.error).toContain("bg boom");
  });
});
