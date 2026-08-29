import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { authedRequest } from "../helpers/auth.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
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
import { mindService } from "../../src/plugins/mind/index.js";
import type { FastifyInstance } from "fastify";
import { restoreDataDir } from "../helpers/env.js";
import { ToolCatalogService } from "../../src/core/tool-catalog-service.js";
import { ToolBlurbStore } from "../../src/core/tool-blurb-store.js";
import type { LLMProvider, LLMChatParams, LLMEvent } from "../../src/provider/types.js";
import type { Tool } from "../../src/tools/types.js";
import type { AgentConfig } from "@mindcloud/shared";

let tmpDir: string;
let context: ApiContext;
let cleanup: () => Promise<void>;
let store: ToolBlurbStore;

class StubProvider implements LLMProvider {
  name = "stub";
  constructor(private readonly lines: string) {}
  supportsModel() {
    return true;
  }
  async *chat(params: LLMChatParams): AsyncIterable<LLMEvent> {
    void params;
    yield { type: "text.delta", delta: this.lines };
    yield { type: "step.end" };
  }
}

function makeTool(name: string, description: string): Tool {
  return {
    name,
    description,
    parameters: z.object({}),
    accesses: [{ resource: "network", action: "read" }],
    async execute() {
      return { success: true, output: "ok" };
    },
  };
}

const DYN = makeTool("mcp__fs__read", "读取文件内容。");
const SKILLS = [{ name: "deploy", description: "作者行：部署技能。" }];

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "api-tool-blurbs-"));
  const originalDataDir = process.env.CLOUDMIND_DATA_DIR;
  process.env.CLOUDMIND_DATA_DIR = tmpDir;
  store = new ToolBlurbStore(path.join(tmpDir, "tool-blurbs.json"));
  const agentRepository = new AgentRepository();
  context = {
    agentRepository,
    getMessageRepository: (agentId: string) => new MessageRepository(agentId),
    getMemoryRepository: (agentId: string) => new MemoryRepository(agentId),
    getActionRepository: (agentId: string) => new ActionRepository(agentId),
    getLLMCallRepository: (agentId: string) => new LLMCallRepository(agentId),
    configRepository: new ConfigRepository(),
    sessionRepository: new SessionRepository(),
    blueprintRepository: new BlueprintRepository(),
    getAgentWorker: async () => undefined,
    mind: mindService,
    toolCatalog: new ToolCatalogService({
      store,
      toolsForAgent: () => [DYN],
      listSkills: async () => SKILLS,
      listAgents: () => agentRepository.list(),
      createProvider: async () => new StubProvider("mcp__fs__read\tLLM读\nskill:deploy\tLLM部署"),
      modelOf: () => "m",
    }),
  };
  cleanup = async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    restoreDataDir(originalDataDir);
  };
  await agentRepository.save("a1", { id: "a1", name: "a1" } as AgentConfig);
});

afterEach(async () => {
  await cleanup();
});

async function makeApp(): Promise<FastifyInstance> {
  const app = await createServer(context);
  await app.ready();
  return app;
}

describe("blurb 管理 v3 端点（决策 3/5）", () => {
  it("GET /agents/:id/tool-catalog：非法 id 400、幽灵 404、正常三清单四态", async () => {
    const app = await makeApp();
    expect((await authedRequest(app.server).get("/agents/bad%20id/tool-catalog")).status).toBe(400);
    expect((await authedRequest(app.server).get("/agents/ghost/tool-catalog")).status).toBe(404);

    const res = await authedRequest(app.server).get("/agents/a1/tool-catalog");
    expect(res.status).toBe(200);
    expect(res.body.dynamic).toEqual([
      expect.objectContaining({ name: "mcp__fs__read", status: "missing" }),
    ]);
    expect(res.body.skills).toEqual([
      expect.objectContaining({ name: "deploy", status: "missing", authorLine: "作者行：部署技能。" }),
    ]);
    expect(res.body.builtin.length).toBeGreaterThan(0);
    expect(res.body.builtin.every((b: { status: string }) => b.status === "core")).toBe(true);
    await app.close();
  });

  it("POST regenerate：zod 400；缺省只碰 missing/stale，成功件转 llm", async () => {
    const app = await makeApp();
    const bad = await authedRequest(app.server)
      .post("/agents/a1/tool-blurbs/regenerate")
      .send({ names: "not-array" });
    expect(bad.status).toBe(400);

    const res = await authedRequest(app.server).post("/agents/a1/tool-blurbs/regenerate").send({});
    expect(res.status).toBe(200);
    expect(res.body.generated.sort()).toEqual(["mcp__fs__read", "skill:deploy"]);
    expect(res.body.failed).toEqual([]);

    const after = await authedRequest(app.server).get("/agents/a1/tool-catalog");
    expect(after.body.dynamic[0].status).toBe("llm");
    expect(after.body.skills[0].status).toBe("llm");
    await app.close();
  });

  it("POST regenerate：user 条目跳过不碰（skipped）", async () => {
    await store.upsertOne("mcp__fs__read", {
      blurb: "用户版",
      descHash: "stale",
      source: "user",
      updatedAt: "2026-08-26T00:00:00.000Z",
    });
    const app = await makeApp();
    const res = await authedRequest(app.server)
      .post("/agents/a1/tool-blurbs/regenerate")
      .send({ names: ["mcp__fs__read", "skill:deploy"] });
    expect(res.status).toBe(200);
    expect(res.body.skipped).toEqual(["mcp__fs__read"]);
    expect(res.body.generated).toEqual(["skill:deploy"]);
    expect((await store.get("mcp__fs__read"))!.blurb).toBe("用户版");
    await app.close();
  });

  it("PUT /tool-blurbs/:name：zod 边界 400、乱写键名 404、生效后 GET 转 user", async () => {
    const app = await makeApp();
    expect(
      (await authedRequest(app.server).put("/tool-blurbs/mcp__fs__read").send({ blurb: "" })).status,
    ).toBe(400);
    expect(
      (await authedRequest(app.server).put("/tool-blurbs/mcp__fs__read").send({ blurb: "x".repeat(201) })).status,
    ).toBe(400);
    expect(
      (await authedRequest(app.server).put("/tool-blurbs/mcp__ghost__x").send({ blurb: "x" })).status,
    ).toBe(404);
    // 内置名不可编辑（fail-closed 同 404）
    expect((await authedRequest(app.server).put("/tool-blurbs/read_file").send({ blurb: "x" })).status).toBe(404);

    const ok = await authedRequest(app.server).put("/tool-blurbs/mcp__fs__read").send({ blurb: "手读文件" });
    expect(ok.status).toBe(200);
    expect(ok.body.source).toBe("user");

    const after = await authedRequest(app.server).get("/agents/a1/tool-catalog");
    expect(after.body.dynamic[0]).toEqual(expect.objectContaining({ status: "user", blurb: "手读文件" }));
    await app.close();
  });

  it("PUT skill:<name>（URL 编码）：命中 skill 名录生效", async () => {
    const app = await makeApp();
    const res = await authedRequest(app.server)
      .put(`/tool-blurbs/${encodeURIComponent("skill:deploy")}`)
      .send({ blurb: "手部署" });
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("user");
    const after = await authedRequest(app.server).get("/agents/a1/tool-catalog");
    expect(after.body.skills[0]).toEqual(
      expect.objectContaining({ status: "user", overrideBlurb: "手部署", authorLine: "作者行：部署技能。" }),
    );
    await app.close();
  });
});
