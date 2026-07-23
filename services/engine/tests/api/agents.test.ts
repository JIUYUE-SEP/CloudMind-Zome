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
import type { ApiContext } from "../../src/api/context.js";
import type { FastifyInstance } from "fastify";
import { restoreDataDir } from "../helpers/env.js";
import { getAgentDir } from "../../src/config/paths.js";
import { DEFAULT_SOUL_TEMPLATE, DEFAULT_MIND_CONTENT } from "../../src/mind/mind-files.js";

async function buildTestContext(): Promise<{ context: ApiContext; cleanup: () => Promise<void> }> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "api-test-"));
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

describe("Agent API", () => {
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

  it("lists agents", async () => {
    const app = await makeApp();
    const res = await request(app.server).get("/agents");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    await app.close();
  });

  it("creates and gets an agent", async () => {
    const app = await makeApp();
    const agent = { id: "a1", name: "A1", persona: "", model: "mock", skills: [], tools: [] };
    const createRes = await request(app.server).post("/agents").send(agent);
    expect(createRes.status).toBe(200);
    expect(createRes.body.id).toBe("a1");

    const getRes = await request(app.server).get("/agents/a1");
    expect(getRes.status).toBe(200);
    expect(getRes.body.name).toBe("A1");
    await app.close();
  });

  it("creates default SOUL.md and MIND.md for a new agent", async () => {
    const app = await makeApp();
    const agent = { id: "a1", name: "A1", persona: "", model: "mock", skills: [], tools: [] };
    const createRes = await request(app.server).post("/agents").send(agent);
    expect(createRes.status).toBe(200);

    const dir = getAgentDir("a1");
    expect(await fs.readFile(path.join(dir, "SOUL.md"), "utf-8")).toBe(DEFAULT_SOUL_TEMPLATE);
    expect(await fs.readFile(path.join(dir, "MIND.md"), "utf-8")).toBe(DEFAULT_MIND_CONTENT);
    await app.close();
  });

  it("updates an agent", async () => {
    const app = await makeApp();
    const agent = { id: "a1", name: "A1", persona: "", model: "mock", skills: [], tools: [] };
    await request(app.server).post("/agents").send(agent);

    const updated = { ...agent, name: "Updated" };
    const putRes = await request(app.server).put("/agents/a1").send(updated);
    expect(putRes.status).toBe(200);
    expect(putRes.body.name).toBe("Updated");
    await app.close();
  });

  it("deletes an agent", async () => {
    const app = await makeApp();
    const agent = { id: "a1", name: "A1", persona: "", model: "mock", skills: [], tools: [] };
    await request(app.server).post("/agents").send(agent);

    const delRes = await request(app.server).delete("/agents/a1");
    expect(delRes.status).toBe(204);

    const getRes = await request(app.server).get("/agents/a1");
    expect(getRes.status).toBe(404);
    await app.close();
  });

  it("rejects invalid agent id on create", async () => {
    const app = await makeApp();
    const agent = { id: "bad id", name: "Bad", persona: "", model: "mock", skills: [], tools: [] };
    const res = await request(app.server).post("/agents").send(agent);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid agent id");
    await app.close();
  });

  it("rejects invalid agent id on update", async () => {
    const app = await makeApp();
    const agent = { id: "bad id", name: "Bad", persona: "", model: "mock", skills: [], tools: [] };
    const res = await request(app.server).put("/agents/bad id").send(agent);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid agent id");
    await app.close();
  });

  it("rejects invalid agent id on get", async () => {
    const app = await makeApp();
    const res = await request(app.server).get("/agents/bad id");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid agent id");
    await app.close();
  });

  it("rejects invalid agent id on delete", async () => {
    const app = await makeApp();
    const res = await request(app.server).delete("/agents/bad id");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid agent id");
    await app.close();
  });

  it("rejects body id that does not match route id on update", async () => {
    const app = await makeApp();
    const agent = { id: "a1", name: "A1", persona: "", model: "mock", skills: [], tools: [] };
    await request(app.server).post("/agents").send(agent);

    const res = await request(app.server).put("/agents/a1").send({ ...agent, id: "a2" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Agent id in body does not match route parameter");
    await app.close();
  });

  it("accepts body id that matches route id on update", async () => {
    const app = await makeApp();
    const agent = { id: "a1", name: "A1", persona: "", model: "mock", skills: [], tools: [] };
    await request(app.server).post("/agents").send(agent);

    const res = await request(app.server).put("/agents/a1").send({ ...agent, name: "Updated", id: "a1" });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Updated");
    await app.close();
  });

  it("persists all extended agent config fields", async () => {
    const app = await makeApp();
    const agent = {
      id: "extended-agent",
      name: "Extended Agent",
      codename: "EA",
      description: "Test agent",
      persona: "Helpful assistant",
      tags: ["test", "extended"],
      representColor: "#ff0000",
      providerId: "openai",
      modelId: "gpt-4o",
      embedderProviderId: "openai",
      embedderModelId: "text-embedding-3-small",
      imageProviderId: "openai",
      imageModelId: "dall-e-3",
      temperature: 0.7,
      topP: 0.9,
      skills: ["web-search"],
      tools: ["bash"],
    };

    const postRes = await request(app.server).post("/agents").send(agent);
    expect(postRes.status).toBe(200);

    const getRes = await request(app.server).get("/agents/extended-agent");
    expect(getRes.status).toBe(200);
    const saved = getRes.body;
    expect(saved.providerId).toBe("openai");
    expect(saved.modelId).toBe("gpt-4o");
    expect(saved.embedderProviderId).toBe("openai");
    expect(saved.embedderModelId).toBe("text-embedding-3-small");
    expect(saved.imageProviderId).toBe("openai");
    expect(saved.imageModelId).toBe("dall-e-3");
    expect(saved.temperature).toBe(0.7);
    expect(saved.topP).toBe(0.9);
    expect(saved.codename).toBe("EA");
    expect(saved.representColor).toBe("#ff0000");
    expect(saved.tags).toEqual(["test", "extended"]);
    await app.close();
  });
});
