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
import { restoreDataDir } from "../helpers/env.js";

async function buildContext(agentId: string): Promise<{ context: ApiContext; cleanup: () => Promise<void> }> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mem-api-test-"));
  const originalDataDir = process.env.CLOUDMIND_DATA_DIR;
  process.env.CLOUDMIND_DATA_DIR = tmpDir;

  const agentRepository = new AgentRepository();
  await agentRepository.save(agentId, {
    id: agentId,
    name: "Test",
    persona: "",
    model: "mock",
    skills: [],
    tools: [],
  });

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
  };

  return {
    context,
    cleanup: async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
      restoreDataDir(originalDataDir);
    },
  };
}

describe("Memory API", () => {
  let context: ApiContext;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const built = await buildContext("a1");
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

  it("lists memories for agent", async () => {
    const app = await makeApp();
    const res = await authedRequest(app.server).get("/memory/a1");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    await app.close();
  });

  it("returns 404 for missing memory", async () => {
    const app = await makeApp();
    const res = await authedRequest(app.server).get("/memory/a1/not-found");
    expect(res.status).toBe(404);
    await app.close();
  });

  it("returns 400 for invalid agent id", async () => {
    const app = await makeApp();
    const res = await authedRequest(app.server).get("/memory/invalid!");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid agent id");
    await app.close();
  });

  it("A5：limit=0/'abc'/-5 回缺省 100（不返回全量），offset 非法回落 0", async () => {
    const repo = context.getMemoryRepository("a1");
    for (let i = 0; i < 120; i++) {
      await repo.append({
        id: `mem${i}`,
        content: `mem${i}`,
        embeddingId: "emb",
        createdAt: new Date(1000 + i).toISOString(),
      });
    }
    const app = await makeApp();
    for (const bad of ["0", "abc", "-5"]) {
      const res = await authedRequest(app.server).get(`/memory/a1?limit=${bad}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(100);
      expect(res.body).not.toHaveLength(120);
    }
    const offsetOk = await authedRequest(app.server).get("/memory/a1?limit=10&offset=5");
    expect(offsetOk.body[0].id).toBe("mem5");
    const offsetBad = await authedRequest(app.server).get("/memory/a1?limit=10&offset=-5");
    expect(offsetBad.body[0].id).toBe("mem0");
    await app.close();
  });
});
