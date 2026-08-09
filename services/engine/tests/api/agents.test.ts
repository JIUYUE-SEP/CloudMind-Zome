import { logger } from "../../src/logger.js";
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
import type { ApiContext } from "../../src/api/context.js";
import type { SidecarClient } from "../../src/sidecar/client.js";
import type { FastifyInstance } from "fastify";
import { restoreDataDir } from "../helpers/env.js";
import { getAgentDir } from "../../src/config/paths.js";
import { DEFAULT_SOUL_TEMPLATE, DEFAULT_MIND_CONTENT } from "../../src/mind/mind-files.js";
import { normalizeReactMaxSteps } from "../../src/core/agent-worker.js";

async function buildTestContext(
  extra?: Partial<ApiContext>,
): Promise<{ context: ApiContext; cleanup: () => Promise<void> }> {
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
    ...extra,
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
    const res = await authedRequest(app.server).get("/agents");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    await app.close();
  });

  it("creates and gets an agent", async () => {
    const app = await makeApp();
    const agent = { id: "a1", name: "A1", persona: "", model: "mock", skills: [], tools: [] };
    const createRes = await authedRequest(app.server).post("/agents").send(agent);
    expect(createRes.status).toBe(200);
    expect(createRes.body.id).toBe("a1");

    const getRes = await authedRequest(app.server).get("/agents/a1");
    expect(getRes.status).toBe(200);
    expect(getRes.body.name).toBe("A1");
    await app.close();
  });

  it("creates default SOUL.md and MIND.md for a new agent", async () => {
    const app = await makeApp();
    const agent = { id: "a1", name: "A1", persona: "", model: "mock", skills: [], tools: [] };
    const createRes = await authedRequest(app.server).post("/agents").send(agent);
    expect(createRes.status).toBe(200);

    const dir = getAgentDir("a1");
    expect(await fs.readFile(path.join(dir, "SOUL.md"), "utf-8")).toBe(DEFAULT_SOUL_TEMPLATE);
    expect(await fs.readFile(path.join(dir, "MIND.md"), "utf-8")).toBe(DEFAULT_MIND_CONTENT);
    await app.close();
  });

  it("updates an agent", async () => {
    const app = await makeApp();
    const agent = { id: "a1", name: "A1", persona: "", model: "mock", skills: [], tools: [] };
    await authedRequest(app.server).post("/agents").send(agent);

    const updated = { ...agent, name: "Updated" };
    const putRes = await authedRequest(app.server).put("/agents/a1").send(updated);
    expect(putRes.status).toBe(200);
    expect(putRes.body.name).toBe("Updated");
    await app.close();
  });

  it("POST/PUT 接受 trustAllTools 字段并持久化（缺省不强制）", async () => {
    const app = await makeApp();
    const agent = {
      id: "a1",
      name: "A1",
      persona: "",
      model: "mock",
      skills: [],
      tools: [],
      trustAllTools: true,
    };
    const createRes = await authedRequest(app.server).post("/agents").send(agent);
    expect(createRes.status).toBe(200);
    expect(createRes.body.trustAllTools).toBe(true);

    const getRes = await authedRequest(app.server).get("/agents/a1");
    expect(getRes.status).toBe(200);
    expect(getRes.body.trustAllTools).toBe(true);

    // PUT 合并语义：显式 false 可关闭
    const putRes = await authedRequest(app.server)
      .put("/agents/a1")
      .send({ ...agent, trustAllTools: false });
    expect(putRes.status).toBe(200);
    expect(putRes.body.trustAllTools).toBe(false);
    await app.close();
  });

  it("trustAllTools 缺省：agent 配置不含该字段（安全默认）", async () => {
    const app = await makeApp();
    const agent = { id: "a1", name: "A1", persona: "", model: "mock", skills: [], tools: [] };
    const createRes = await authedRequest(app.server).post("/agents").send(agent);
    expect(createRes.status).toBe(200);
    expect(createRes.body.trustAllTools).toBeUndefined();
    await app.close();
  });

  it("POST/PUT 未知字段显式 400 并指出字段名与提示（功能 Minor-1）", async () => {
    const app = await makeApp();
    // provider（错）vs providerId（对）：400 + 提示正确字段名
    const badPost = await authedRequest(app.server)
      .post("/agents")
      .send({ id: "a1", name: "A1", persona: "", model: "mock", skills: [], tools: [], provider: "p-1" });
    expect(badPost.status).toBe(400);
    expect(badPost.body.error).toContain("未知字段");
    expect(badPost.body.error).toContain("provider");
    expect(badPost.body.error).toContain("providerId");

    // 无提示映射的未知字段：只报字段名
    const badPost2 = await authedRequest(app.server)
      .post("/agents")
      .send({ id: "a1", name: "A1", persona: "", model: "mock", skills: [], tools: [], fooBar: 1 });
    expect(badPost2.status).toBe(400);
    expect(badPost2.body.error).toContain("fooBar");

    // PUT 同样拒绝
    const agent = { id: "a1", name: "A1", persona: "", model: "mock", skills: [], tools: [] };
    await authedRequest(app.server).post("/agents").send(agent);
    const badPut = await authedRequest(app.server).put("/agents/a1").send({ ...agent, provider: "p-1" });
    expect(badPut.status).toBe(400);
    expect(badPut.body.error).toContain("providerId");

    // GET 回显（含 schemaVersion 版本戳）原样 PUT 回传：合法，不误伤
    const getRes = await authedRequest(app.server).get("/agents/a1");
    const putRes = await authedRequest(app.server).put("/agents/a1").send(getRes.body);
    expect(putRes.status).toBe(200);
    await app.close();
  });

  it("deletes an agent", async () => {
    const app = await makeApp();
    const agent = { id: "a1", name: "A1", persona: "", model: "mock", skills: [], tools: [] };
    await authedRequest(app.server).post("/agents").send(agent);

    const delRes = await authedRequest(app.server).delete("/agents/a1");
    expect(delRes.status).toBe(204);

    const getRes = await authedRequest(app.server).get("/agents/a1");
    expect(getRes.status).toBe(404);
    await app.close();
  });

  it("deletes an agent and cascades vector cleanup via sidecar DeleteAgent（P1-3）", async () => {
    const deleteAgent = vi.fn(async () => true);
    const built = await buildTestContext({
      sidecarClient: { deleteAgent } as unknown as SidecarClient,
    });
    const app = await createServer(built.context);
    await app.ready();
    try {
      const agent = { id: "a1", name: "A1", persona: "", model: "mock", skills: [], tools: [] };
      await authedRequest(app.server).post("/agents").send(agent);
      const delRes = await authedRequest(app.server).delete("/agents/a1");
      expect(delRes.status).toBe(204);
      expect(deleteAgent).toHaveBeenCalledWith("a1");
    } finally {
      await app.close();
      await built.cleanup();
    }
  });

  it("sidecar DeleteAgent 未成功时降级 warn 不阻断删除（P1-3）", async () => {
    const deleteAgent = vi.fn(async () => false);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const built = await buildTestContext({
      sidecarClient: { deleteAgent } as unknown as SidecarClient,
    });
    const app = await createServer(built.context);
    await app.ready();
    try {
      const agent = { id: "a1", name: "A1", persona: "", model: "mock", skills: [], tools: [] };
      await authedRequest(app.server).post("/agents").send(agent);
      const delRes = await authedRequest(app.server).delete("/agents/a1");
      // 删除仍成功：文件删除是主要的，向量内存缓存待 sidecar 重启清除
      expect(delRes.status).toBe(204);
      const getRes = await authedRequest(app.server).get("/agents/a1");
      expect(getRes.status).toBe(404);
      expect(warn).toHaveBeenCalled();
    } finally {
      await app.close();
      await built.cleanup();
      warn.mockRestore();
    }
  });

  it("rejects invalid agent id on create", async () => {
    const app = await makeApp();
    const agent = { id: "bad id", name: "Bad", persona: "", model: "mock", skills: [], tools: [] };
    const res = await authedRequest(app.server).post("/agents").send(agent);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid agent id");
    await app.close();
  });

  it("rejects invalid agent id on update", async () => {
    const app = await makeApp();
    const agent = { id: "bad id", name: "Bad", persona: "", model: "mock", skills: [], tools: [] };
    const res = await authedRequest(app.server).put("/agents/bad id").send(agent);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid agent id");
    await app.close();
  });

  it("rejects invalid agent id on get", async () => {
    const app = await makeApp();
    const res = await authedRequest(app.server).get("/agents/bad id");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid agent id");
    await app.close();
  });

  it("rejects invalid agent id on delete", async () => {
    const app = await makeApp();
    const res = await authedRequest(app.server).delete("/agents/bad id");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid agent id");
    await app.close();
  });

  it("rejects body id that does not match route id on update", async () => {
    const app = await makeApp();
    const agent = { id: "a1", name: "A1", persona: "", model: "mock", skills: [], tools: [] };
    await authedRequest(app.server).post("/agents").send(agent);

    const res = await authedRequest(app.server).put("/agents/a1").send({ ...agent, id: "a2" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Agent id in body does not match route parameter");
    await app.close();
  });

  it("accepts body id that matches route id on update", async () => {
    const app = await makeApp();
    const agent = { id: "a1", name: "A1", persona: "", model: "mock", skills: [], tools: [] };
    await authedRequest(app.server).post("/agents").send(agent);

    const res = await authedRequest(app.server).put("/agents/a1").send({ ...agent, name: "Updated", id: "a1" });
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

    const postRes = await authedRequest(app.server).post("/agents").send(agent);
    expect(postRes.status).toBe(200);

    const getRes = await authedRequest(app.server).get("/agents/extended-agent");
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

  it("PUT 合并语义：未传字段保留原值（真机踩坑修复）", async () => {
    const app = await makeApp();
    const agent = { id: "a1", name: "A1", persona: "人格设定", model: "mock", skills: ["s1"], tools: ["read_file"], subagentNotify: true };
    await authedRequest(app.server).post("/agents").send(agent);

    // 部分更新：只改 name
    const putRes = await authedRequest(app.server).put("/agents/a1").send({ name: "Renamed" });
    expect(putRes.status).toBe(200);
    expect(putRes.body.name).toBe("Renamed");

    // 未传字段全部保留
    const getRes = await authedRequest(app.server).get("/agents/a1");
    expect(getRes.body.persona).toBe("人格设定");
    expect(getRes.body.skills).toEqual(["s1"]);
    expect(getRes.body.tools).toEqual(["read_file"]);
    expect(getRes.body.subagentNotify).toBe(true);
    await app.close();
  });

  it("POST/PUT 接受 subagentNotify 字段（白名单补全）", async () => {
    const app = await makeApp();
    const res = await authedRequest(app.server)
      .post("/agents")
      .send({ id: "a1", name: "A1", persona: "", model: "mock", skills: [], tools: [], subagentNotify: false });
    expect(res.status).toBe(200);
    const getRes = await authedRequest(app.server).get("/agents/a1");
    expect(getRes.body.subagentNotify).toBe(false);
    await app.close();
  });

  it("POST/PUT 接受 reactMaxSteps 字段；999 由引擎归一 clamp 500", async () => {
    const app = await makeApp();
    const agent = {
      id: "a1",
      name: "A1",
      persona: "",
      model: "mock",
      skills: [],
      tools: [],
      reactMaxSteps: 200,
    };
    const postRes = await authedRequest(app.server).post("/agents").send(agent);
    expect(postRes.status).toBe(200);
    expect(postRes.body.reactMaxSteps).toBe(200);

    const getRes = await authedRequest(app.server).get("/agents/a1");
    expect(getRes.body.reactMaxSteps).toBe(200);

    // PUT 合并语义：999 合法落库（REST 不拦越界值），引擎侧 normalize clamp 到 500
    const putRes = await authedRequest(app.server).put("/agents/a1").send({ reactMaxSteps: 999 });
    expect(putRes.status).toBe(200);
    expect(putRes.body.reactMaxSteps).toBe(999);
    expect(normalizeReactMaxSteps(putRes.body.reactMaxSteps)).toBe(500);
    await app.close();
  });

  it("PUT 显式清空数组字段（skills: []）生效", async () => {
    const app = await makeApp();
    await authedRequest(app.server).post("/agents").send({ id: "a1", name: "A1", persona: "", model: "mock", skills: ["s1"], tools: ["read_file"] });
    const putRes = await authedRequest(app.server).put("/agents/a1").send({ skills: [] });
    expect(putRes.status).toBe(200);
    const getRes = await authedRequest(app.server).get("/agents/a1");
    expect(getRes.body.skills).toEqual([]);
    expect(getRes.body.tools).toEqual(["read_file"]);
    await app.close();
  });

  it("PUT 对不存在 id 走 upsert 创建", async () => {
    const app = await makeApp();
    const putRes = await authedRequest(app.server).put("/agents/newbie").send({ name: "Newbie", persona: "", model: "mock", skills: [], tools: [] });
    expect(putRes.status).toBe(200);
    const getRes = await authedRequest(app.server).get("/agents/newbie");
    expect(getRes.body.name).toBe("Newbie");
    await app.close();
  });
});
