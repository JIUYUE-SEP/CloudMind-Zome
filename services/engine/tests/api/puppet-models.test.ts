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
import { createPuppetModelService } from "../../src/subagent/puppet-models.js";
import { restoreDataDir } from "../helpers/env.js";
import type { ApiContext } from "../../src/api/context.js";
import type { FastifyInstance } from "fastify";

let tmpDir: string;
let originalDataDir: string | undefined;
let app: FastifyInstance;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "puppet-models-api-test-"));
  originalDataDir = process.env.CLOUDMIND_DATA_DIR;
  process.env.CLOUDMIND_DATA_DIR = tmpDir;

  const agentRepository = new AgentRepository();
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
    puppetModelService: createPuppetModelService(),
  };
  app = await createServer(context);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  restoreDataDir(originalDataDir);
  await fsp.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("GET /puppet-models", () => {
  it("内置四型号：每项含 name/description/personaSnippet/suggestedTools + source=builtin", async () => {
    const res = await authedRequest(app.server).get("/puppet-models");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(4);
    expect(res.body.map((m: { name: string }) => m.name)).toEqual([
      "规划师",
      "码农",
      "调研员",
      "审查员",
    ]);
    for (const model of res.body) {
      expect(model.source).toBe("builtin");
      expect(typeof model.name).toBe("string");
      expect(typeof model.description).toBe("string");
      expect(typeof model.personaSnippet).toBe("string");
      expect(Array.isArray(model.suggestedTools)).toBe(true);
    }
  });

  it("自定义目录有文件：并入列表并带 source=custom", async () => {
    const dir = path.join(tmpDir, "puppet-models");
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(
      path.join(dir, "analyst.json"),
      JSON.stringify({
        name: "数据分析师",
        description: "数据分析",
        personaSnippet: "你是数据分析师型傀儡。你以证据为准。",
        suggestedTools: ["read_file", "bash"],
      }),
      "utf-8",
    );

    const res = await authedRequest(app.server).get("/puppet-models");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(5);
    const custom = res.body.find((m: { name: string }) => m.name === "数据分析师");
    expect(custom).toMatchObject({ source: "custom", suggestedTools: ["read_file", "bash"] });
  });

  it("同名自定义覆盖内置：source=custom 且内容为自定义", async () => {
    const dir = path.join(tmpDir, "puppet-models");
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(
      path.join(dir, "planner.json"),
      JSON.stringify({
        name: "规划师",
        description: "自定义规划师",
        personaSnippet: "你是自定义规划师型傀儡。你按用户偏好规划。",
      }),
      "utf-8",
    );

    const res = await authedRequest(app.server).get("/puppet-models");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(4);
    const planner = res.body.find((m: { name: string }) => m.name === "规划师");
    expect(planner).toMatchObject({ source: "custom", description: "自定义规划师" });
  });
});
