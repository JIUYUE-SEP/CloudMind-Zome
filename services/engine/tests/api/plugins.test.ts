import { describe, it, expect, afterEach } from "vitest";
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
import type { ExternalFace } from "../../src/plugins/external/index.js";
import { restoreDataDir } from "../helpers/env.js";

async function buildTestContext(
  external?: ExternalFace,
): Promise<{ context: ApiContext; cleanup: () => Promise<void> }> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-api-test-"));
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
    ...(external !== undefined ? { external } : {}),
  };

  return {
    context,
    cleanup: async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
      restoreDataDir(originalDataDir);
    },
  };
}

describe("Plugins API", () => {
  let cleanup: () => Promise<void>;

  afterEach(async () => {
    await cleanup();
  });

  it("GET /plugins 返回 external 面的 loaded/skipped/perAgent 三字段", async () => {
    const external: ExternalFace = {
      loaded: ["hello"],
      skipped: [{ name: "broken", reason: "missing-entry" }],
      perAgent: [
        { agentId: "a1", name: "hello", status: "loaded" },
        { agentId: "a2", name: "hello", status: "disabled" },
      ],
    };
    const built = await buildTestContext(external);
    cleanup = built.cleanup;
    const app = await createServer(built.context);
    await app.ready();

    const res = await authedRequest(app.server).get("/plugins");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      loaded: ["hello"],
      skipped: [{ name: "broken", reason: "missing-entry" }],
      perAgent: [
        { agentId: "a1", name: "hello", status: "loaded" },
        { agentId: "a2", name: "hello", status: "disabled" },
      ],
    });
    await app.close();
  });

  it("GET /plugins 在 external 面未装配时按空结果返回（不 500）", async () => {
    const built = await buildTestContext();
    cleanup = built.cleanup;
    const app = await createServer(built.context);
    await app.ready();

    const res = await authedRequest(app.server).get("/plugins");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ loaded: [], skipped: [], perAgent: [] });
    await app.close();
  });
});
