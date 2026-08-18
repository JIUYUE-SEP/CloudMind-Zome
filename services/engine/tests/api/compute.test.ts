import { describe, it, expect, vi, beforeEach, afterEach, type MockedFunction } from "vitest";
import { authedRequest } from "../helpers/auth.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
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
import { computeService } from "../../src/plugins/compute/index.js";
import type { FastifyInstance } from "fastify";
import type { AgentWorker } from "../../src/core/agent-worker.js";
import { restoreDataDir } from "../helpers/env.js";
import { logger } from "../../src/logger.js";

// R2（review）：OpenAI SDK 在 Node 下走 node-fetch，global fetch stub 影响不到它，
// 文件级 mock 仅在本测试文件生效；未显式设置 listImpl 时直接报错，防止静默走真实网络
vi.mock("openai", () => {
  let listImpl: (() => Promise<unknown>) | null = null;
  class MockOpenAI {
    static __setListImpl(fn: (() => Promise<unknown>) | null): void {
      listImpl = fn;
    }
    constructor(readonly options: Record<string, unknown>) {}
    get models(): { list: () => Promise<unknown> } {
      return {
        list: async () => {
          if (listImpl) return listImpl();
          throw new Error("openai mock: models.list 未设置 __setListImpl");
        },
      };
    }
  }
  return { default: MockOpenAI };
});

// SSRF DNS 校验 mock：只覆盖 lookup，其余导出透传真实实现（避免误伤依赖图里
// 其它消费 node:dns/promises 的模块）；各用例的默认解析结果在 beforeEach 重置
vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns/promises")>();
  return { ...actual, lookup: vi.fn() };
});

// lookup 重载较多，收窄到 all:true 的调用形态便于 mockResolvedValue 传数组
const lookupMock = lookup as unknown as MockedFunction<
  (hostname: string, options?: { all?: boolean; verbatim?: boolean }) => Promise<LookupAddress[]>
>;

async function buildContext(): Promise<{ context: ApiContext; cleanup: () => Promise<void> }> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "compute-api-test-"));
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
    compute: computeService,
  };

  return {
    context,
    cleanup: async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
      restoreDataDir(originalDataDir);
    },
  };
}

describe("Compute API", () => {
  let context: ApiContext;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    // 默认解析为公网地址：既有用例的合法外部域名走 DNS 路径后仍放行；
    // SSRF DNS 用例按需覆盖此默认实现
    lookupMock.mockReset();
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const built = await buildContext();
    context = built.context;
    cleanup = built.cleanup;
  });

  afterEach(async () => {
    await cleanup();
    vi.unstubAllGlobals();
  });

  async function makeApp(): Promise<FastifyInstance> {
    const app = await createServer(context);
    await app.ready();
    return app;
  }

  it("creates and lists providers with masked api keys", async () => {
    const app = await makeApp();
    const provider = {
      id: "p1",
      displayName: "OpenAI",
      providerType: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      models: [{ id: "gpt-4o", displayName: "GPT-4o", modelType: "llm" as const }],
    };
    const createRes = await authedRequest(app.server).post("/compute/providers").send(provider);
    expect(createRes.status).toBe(200);
    expect(createRes.body.displayName).toBe("OpenAI");
    expect(createRes.body.apiKey).toBe("***");

    const listRes = await authedRequest(app.server).get("/compute/providers");
    expect(listRes.status).toBe(200);
    expect(listRes.body).toHaveLength(1);
    expect(listRes.body[0].apiKey).toBe("***");
    await app.close();
  });

  it("F5：create provider 拒绝空串/纯空白 displayName（400，不落库）", async () => {
    const app = await makeApp();
    for (const displayName of ["", "   "]) {
      const res = await authedRequest(app.server).post("/compute/providers").send({
        displayName,
        providerType: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-test",
        models: [],
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("displayName");
    }
    const listRes = await authedRequest(app.server).get("/compute/providers");
    expect(listRes.status).toBe(200);
    expect(listRes.body).toHaveLength(0);
    await app.close();
  });

  it("M33：POST providers 显式 id 重复 → 409，不落第二条（对照 POST /agents 口径）", async () => {
    const app = await makeApp();
    const provider = {
      id: "p-dup",
      displayName: "Original",
      providerType: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      models: [],
    };
    const first = await authedRequest(app.server).post("/compute/providers").send(provider);
    expect(first.status).toBe(200);

    const dup = await authedRequest(app.server)
      .post("/compute/providers")
      .send({ ...provider, displayName: "Overwrite Attempt" });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toContain("already exists");
    expect(dup.body.error).toContain("p-dup");

    // 原配置未被覆盖，也未落第二条
    const listRes = await authedRequest(app.server).get("/compute/providers");
    expect(listRes.body).toHaveLength(1);
    expect(listRes.body[0].displayName).toBe("Original");
    await app.close();
  });

  it("providerType 白名单：非法值 400 不落库；缺省维持既有口径落 openai", async () => {
    const app = await makeApp();
    const bad = await authedRequest(app.server).post("/compute/providers").send({
      displayName: "Bad Type",
      providerType: "grpc",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      models: [],
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("providerType");

    // 缺省 providerType 维持既有口径落 "openai"（对齐 shared ProviderConfig 枚举，当前仅此值）
    const ok = await authedRequest(app.server).post("/compute/providers").send({
      displayName: "Default Type",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      models: [],
    });
    expect(ok.status).toBe(200);
    const config = await context.configRepository.load();
    expect(config.providers).toHaveLength(1);
    expect(config.providers[0].providerType).toBe("openai");
    await app.close();
  });

  it("M33：PUT provider 拒绝空串/纯空白 displayName（400，原值保留）", async () => {
    const app = await makeApp();
    await authedRequest(app.server).post("/compute/providers").send({
      id: "p-name",
      displayName: "Keep Name",
      providerType: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      models: [],
    });
    for (const displayName of ["", "   "]) {
      const res = await authedRequest(app.server)
        .put("/compute/providers/p-name")
        .send({ displayName });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("displayName");
    }
    const config = await context.configRepository.load();
    expect(config.providers[0].displayName).toBe("Keep Name");
    await app.close();
  });

  it("M33：test 端点无 apiKey → 400 明确文案（不再被误报 502）", async () => {
    const app = await makeApp();
    await authedRequest(app.server).post("/compute/providers").send({
      id: "p-no-key",
      displayName: "No Key",
      providerType: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiMode: "chat_completions",
      models: [],
    });
    const res = await authedRequest(app.server).post("/compute/providers/p-no-key/test");
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("apiKey");
    await app.close();
  });

  it("M28：compute 写端点缺 body 不 500（POST 400；PUT 按空 body no-op）", async () => {
    const app = await makeApp();
    // 无 content-type 无 body：request.body 为 undefined，原先 TypeError 500
    const createRes = await authedRequest(app.server).post("/compute/providers");
    expect(createRes.status).toBe(400);
    expect(createRes.body.error).toContain("displayName");

    await authedRequest(app.server).post("/compute/providers").send({
      id: "p-nobody",
      displayName: "No Body",
      providerType: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      models: [{ id: "gpt-4o", displayName: "GPT-4o", modelType: "llm" }],
    });

    // 空 body PUT provider = 无字段变更 no-op
    const putRes = await authedRequest(app.server).put("/compute/providers/p-nobody");
    expect(putRes.status).toBe(200);
    expect(putRes.body.displayName).toBe("No Body");

    // 空 body POST models = 缺 id 400
    const addRes = await authedRequest(app.server).post("/compute/providers/p-nobody/models");
    expect(addRes.status).toBe(400);
    expect(addRes.body.error).toContain("id");

    // 空 body PUT models = 无字段变更 no-op
    const putModelRes = await authedRequest(app.server).put("/compute/providers/p-nobody/models/gpt-4o");
    expect(putModelRes.status).toBe(200);
    expect(putModelRes.body.displayName).toBe("GPT-4o");
    await app.close();
  });

  it("updates and deletes a provider", async () => {
    const app = await makeApp();
    const provider = {
      id: "p1",
      displayName: "OpenAI",
      providerType: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      models: [],
    };
    await authedRequest(app.server).post("/compute/providers").send(provider);

    const updateRes = await authedRequest(app.server).put("/compute/providers/p1").send({ displayName: "OpenAI Updated" });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.displayName).toBe("OpenAI Updated");

    const delRes = await authedRequest(app.server).delete("/compute/providers/p1");
    expect(delRes.status).toBe(204);

    const listRes = await authedRequest(app.server).get("/compute/providers");
    expect(listRes.body).toHaveLength(0);
    await app.close();
  });

  it("P1-7：PUT provider 退役引用它的 worker，下一次解析按新 key（不重启）", async () => {
    const app = await makeApp();
    await authedRequest(app.server).post("/compute/providers").send({
      id: "p-hot",
      displayName: "Hot Provider",
      providerType: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "key-old",
      models: [],
    });
    await context.agentRepository.save("a-hot", {
      id: "a-hot",
      name: "Hot",
      persona: "",
      model: "mock",
      providerId: "p-hot",
      skills: [],
      tools: [],
    });

    // 模拟 bootstrap 的 worker 创建链：每次 getOrCreate 都从活配置快照 provider
    const created: Array<{ id: string; apiKey: string | undefined }> = [];
    const retired = new Set<string>();
    context.retireAgentWorker = (agentId: string) => {
      retired.add(agentId);
    };
    context.getAgentWorker = async (agentId: string) => {
      const config = await context.configRepository.load();
      const provider = config.providers.find((p) => p.id === "p-hot");
      created.push({ id: agentId, apiKey: provider?.apiKey });
      return { workerTag: created.length } as unknown as AgentWorker;
    };

    const before = await context.getAgentWorker("a-hot");
    expect(created).toEqual([{ id: "a-hot", apiKey: "key-old" }]);

    const putRes = await authedRequest(app.server)
      .put("/compute/providers/p-hot")
      .send({ apiKey: "key-new" });
    expect(putRes.status).toBe(200);

    // worker 被退役：下一次 getAgentWorker 重建，拿到新 key
    expect(retired.has("a-hot")).toBe(true);
    const after = await context.getAgentWorker("a-hot");
    expect(after).not.toBe(before);
    expect(created).toEqual([
      { id: "a-hot", apiKey: "key-old" },
      { id: "a-hot", apiKey: "key-new" },
    ]);
    await app.close();
  });

  it("P1-7：DELETE provider 退役引用它的 worker，后续明确 provider 不存在而非旧端点快照", async () => {
    const app = await makeApp();
    await authedRequest(app.server).post("/compute/providers").send({
      id: "p-del",
      displayName: "Del Provider",
      providerType: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "key-old",
      models: [],
    });
    await context.agentRepository.save("a-del", {
      id: "a-del",
      name: "Del",
      persona: "",
      model: "mock",
      providerId: "p-del",
      skills: [],
      tools: [],
    });

    const created: string[] = [];
    const retired = new Set<string>();
    context.retireAgentWorker = (agentId: string) => {
      retired.add(agentId);
    };
    context.getAgentWorker = async () => {
      const config = await context.configRepository.load();
      const provider = config.providers.find((p) => p.id === "p-del");
      // 有 provider → 正常适配器快照；无 provider → createLLMProvider 的
      // "provider 不存在" 明确报错路径，绝不再回落创建时快照打旧端点
      created.push(provider ? `snapshot:${provider.apiKey}` : "error:provider-missing");
      return { workerTag: created.length } as unknown as AgentWorker;
    };

    await context.getAgentWorker("a-del");
    const delRes = await authedRequest(app.server).delete("/compute/providers/p-del");
    expect(delRes.status).toBe(204);
    expect(retired.has("a-del")).toBe(true);

    await context.getAgentWorker("a-del");
    expect(created).toEqual(["snapshot:key-old", "error:provider-missing"]);
    await app.close();
  });

  it("P1-7：DELETE 降级链引用的 provider 同样退役 worker", async () => {
    const app = await makeApp();
    await authedRequest(app.server).post("/compute/providers").send({
      id: "p-main",
      displayName: "Main",
      providerType: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "main-key",
      models: [],
    });
    await authedRequest(app.server).post("/compute/providers").send({
      id: "p-fb",
      displayName: "Fallback",
      providerType: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "fb-key",
      models: [],
    });
    await context.agentRepository.save("a-fb", {
      id: "a-fb",
      name: "FB",
      persona: "",
      model: "mock",
      providerId: "p-main",
      fallbackProviderIds: ["p-fb"],
      skills: [],
      tools: [],
    });

    let creates = 0;
    const retired = new Set<string>();
    context.retireAgentWorker = (agentId: string) => {
      retired.add(agentId);
    };
    context.getAgentWorker = async () => {
      creates++;
      return { workerTag: creates } as unknown as AgentWorker;
    };

    await context.getAgentWorker("a-fb");
    const delRes = await authedRequest(app.server).delete("/compute/providers/p-fb");
    expect(delRes.status).toBe(204);
    expect(retired.has("a-fb")).toBe(true);
    await context.getAgentWorker("a-fb");
    expect(creates).toBe(2);
    await app.close();
  });

  // H6：型号端点（POST/PUT/DELETE models）变更后同样退役引用该 provider 的 worker——
  // hasModelApiModeOverride 只在 worker 创建时判定，退役后下一次 getOrCreate 才按活配置重建
  it("H6：POST 新增型号（首个型号级 apiMode 覆盖）退役引用该 provider 的 worker", async () => {
    const app = await makeApp();
    await authedRequest(app.server).post("/compute/providers").send({
      id: "p-m-add",
      displayName: "Model Add",
      providerType: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "key",
      models: [],
    });
    await context.agentRepository.save("a-m-add", {
      id: "a-m-add",
      name: "Model Add",
      persona: "",
      model: "mock",
      providerId: "p-m-add",
      skills: [],
      tools: [],
    });

    let creates = 0;
    const retired = new Set<string>();
    context.retireAgentWorker = (agentId: string) => {
      retired.add(agentId);
    };
    context.getAgentWorker = async () => {
      creates++;
      return { workerTag: creates } as unknown as AgentWorker;
    };

    await context.getAgentWorker("a-m-add");
    const res = await authedRequest(app.server)
      .post("/compute/providers/p-m-add/models")
      .send({ id: "m-1", modelType: "llm", apiMode: "responses" });
    expect(res.status).toBe(200);
    expect(res.body.apiMode).toBe("responses");
    // worker 被退役：下一次 getAgentWorker 重建（hasModelApiModeOverride 按活配置重判）
    expect(retired.has("a-m-add")).toBe(true);
    await context.getAgentWorker("a-m-add");
    expect(creates).toBe(2);
    await app.close();
  });

  it("H6：PUT 型号级 apiMode 覆盖退役引用该 provider 的 worker", async () => {
    const app = await makeApp();
    await authedRequest(app.server).post("/compute/providers").send({
      id: "p-m-put",
      displayName: "Model Put",
      providerType: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "key",
      models: [{ id: "m-1", displayName: "M1", modelType: "llm" }],
    });
    await context.agentRepository.save("a-m-put", {
      id: "a-m-put",
      name: "Model Put",
      persona: "",
      model: "mock",
      providerId: "p-m-put",
      skills: [],
      tools: [],
    });

    let creates = 0;
    const retired = new Set<string>();
    context.retireAgentWorker = (agentId: string) => {
      retired.add(agentId);
    };
    context.getAgentWorker = async () => {
      creates++;
      return { workerTag: creates } as unknown as AgentWorker;
    };

    const before = await context.getAgentWorker("a-m-put");
    const res = await authedRequest(app.server)
      .put("/compute/providers/p-m-put/models/m-1")
      .send({ apiMode: "anthropic" });
    expect(res.status).toBe(200);
    expect(res.body.apiMode).toBe("anthropic");
    expect(retired.has("a-m-put")).toBe(true);
    const after = await context.getAgentWorker("a-m-put");
    expect(after).not.toBe(before);
    expect(creates).toBe(2);
    await app.close();
  });

  it("H6：DELETE 型号退役引用该 provider 的 worker", async () => {
    const app = await makeApp();
    await authedRequest(app.server).post("/compute/providers").send({
      id: "p-m-del",
      displayName: "Model Del",
      providerType: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "key",
      models: [{ id: "m-1", displayName: "M1", modelType: "llm", apiMode: "responses" }],
    });
    await context.agentRepository.save("a-m-del", {
      id: "a-m-del",
      name: "Model Del",
      persona: "",
      model: "mock",
      providerId: "p-m-del",
      skills: [],
      tools: [],
    });

    let creates = 0;
    const retired = new Set<string>();
    context.retireAgentWorker = (agentId: string) => {
      retired.add(agentId);
    };
    context.getAgentWorker = async () => {
      creates++;
      return { workerTag: creates } as unknown as AgentWorker;
    };

    await context.getAgentWorker("a-m-del");
    const res = await authedRequest(app.server).delete("/compute/providers/p-m-del/models/m-1");
    expect(res.status).toBe(204);
    expect(retired.has("a-m-del")).toBe(true);
    await context.getAgentWorker("a-m-del");
    expect(creates).toBe(2);
    await app.close();
  });

  it("keeps the existing apiKey when update sends an empty string", async () => {
    const app = await makeApp();
    const provider = {
      id: "p1",
      displayName: "OpenAI",
      providerType: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      models: [],
    };
    await authedRequest(app.server).post("/compute/providers").send(provider);

    // 编辑表单留空表示"不修改"，不能把已保存的密钥覆盖掉
    const updateRes = await authedRequest(app.server)
      .put("/compute/providers/p1")
      .send({ displayName: "Renamed", apiKey: "" });
    expect(updateRes.status).toBe(200);

    const config = await context.configRepository.load();
    expect(config.providers[0].displayName).toBe("Renamed");
    expect(config.providers[0].apiKey).toBe("sk-test");
    await app.close();
  });

  it("PUT provider 掩码 \"***\" 回写不毁已存密钥（与 config.ts tavily 口径一致）", async () => {
    const app = await makeApp();
    await authedRequest(app.server).post("/compute/providers").send({
      id: "p-mask",
      displayName: "Mask",
      providerType: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-real",
      models: [],
    });

    // 前端把 GET 到的掩码原样 PUT 回来：真实密钥必须保持不动（不得把 "***" 加密落库）
    const res = await authedRequest(app.server)
      .put("/compute/providers/p-mask")
      .send({ displayName: "Mask Renamed", apiKey: "***" });
    expect(res.status).toBe(200);
    expect(res.body.apiKey).toBe("***");

    const config = await context.configRepository.load();
    expect(config.providers[0].displayName).toBe("Mask Renamed");
    expect(config.providers[0].apiKey).toBe("sk-real");
    await app.close();
  });

  it("F10：DELETE provider 不存在 → 404（不落盘、不触发退役副作用）", async () => {
    const app = await makeApp();
    const retireSpy = vi.fn();
    context.retireAgentWorker = retireSpy;

    const res = await authedRequest(app.server).delete("/compute/providers/ghost");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Provider not found");
    expect(retireSpy).not.toHaveBeenCalled();
    await app.close();
  });

  it("F10：DELETE model provider 不存在 / 型号未命中 → 404（现状不变）", async () => {
    const app = await makeApp();
    await authedRequest(app.server).post("/compute/providers").send({
      id: "p-del404",
      displayName: "Del404",
      providerType: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      models: [{ id: "gpt-4o", displayName: "GPT-4o", modelType: "llm" }],
    });

    const noProvider = await authedRequest(app.server).delete("/compute/providers/ghost/models/gpt-4o");
    expect(noProvider.status).toBe(404);
    expect(noProvider.body.error).toBe("Provider not found");

    const noModel = await authedRequest(app.server).delete("/compute/providers/p-del404/models/ghost-model");
    expect(noModel.status).toBe(404);
    expect(noModel.body.error).toBe("Model not found");

    // 未命中的删除不改现状、不落盘
    const config = await context.configRepository.load();
    expect(config.providers[0].models).toHaveLength(1);
    await app.close();
  });

  it("并发 POST 两个 provider 不互丢（repository.update 串行化读-改-写）", async () => {
    const app = await makeApp();
    const [r1, r2] = await Promise.all([
      authedRequest(app.server).post("/compute/providers").send({
        id: "p-conc-1",
        displayName: "Conc 1",
        providerType: "openai",
        baseUrl: "https://api.openai.com/v1",
        models: [],
      }),
      authedRequest(app.server).post("/compute/providers").send({
        id: "p-conc-2",
        displayName: "Conc 2",
        providerType: "openai",
        baseUrl: "https://api.deepseek.com",
        models: [],
      }),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    const listRes = await authedRequest(app.server).get("/compute/providers");
    const ids = listRes.body.map((p: { id: string }) => p.id).sort();
    expect(ids).toEqual(["p-conc-1", "p-conc-2"]);
    await app.close();
  });

  it("manages models under a provider", async () => {
    const app = await makeApp();
    const provider = {
      id: "p1",
      displayName: "OpenAI",
      providerType: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      models: [],
    };
    await authedRequest(app.server).post("/compute/providers").send(provider);

    const model = { id: "gpt-4o", displayName: "GPT-4o", modelType: "llm" };
    const addRes = await authedRequest(app.server).post("/compute/providers/p1/models").send(model);
    expect(addRes.status).toBe(200);

    const updateRes = await authedRequest(app.server).put("/compute/providers/p1/models/gpt-4o").send({ displayName: "GPT-4o Updated" });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.displayName).toBe("GPT-4o Updated");

    const delRes = await authedRequest(app.server).delete("/compute/providers/p1/models/gpt-4o");
    expect(delRes.status).toBe(204);

    const listRes = await authedRequest(app.server).get("/compute/providers");
    expect(listRes.body[0].models).toHaveLength(0);
    await app.close();
  });

  it("rejects localhost baseUrl", async () => {
    const app = await makeApp();
    const res = await authedRequest(app.server).post("/compute/providers").send({
      id: "local",
      displayName: "Local",
      providerType: "openai",
      baseUrl: "http://localhost:11434",
      models: [],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid baseUrl");
    await app.close();
  });

  it("rejects metadata IP baseUrl", async () => {
    const app = await makeApp();
    const res = await authedRequest(app.server).post("/compute/providers").send({
      id: "metadata",
      displayName: "Metadata",
      providerType: "openai",
      baseUrl: "http://169.254.169.254",
      models: [],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid baseUrl");
    await app.close();
  });

  it("rejects non-http schemes baseUrl", async () => {
    const app = await makeApp();
    const res = await authedRequest(app.server).post("/compute/providers").send({
      id: "file",
      displayName: "File",
      providerType: "openai",
      baseUrl: "file:///etc/passwd",
      models: [],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid baseUrl");
    await app.close();
  });

  it("rejects IPv6 loopback baseUrl", async () => {
    const app = await makeApp();
    const res = await authedRequest(app.server).post("/compute/providers").send({
      id: "v6loop",
      displayName: "V6Loop",
      providerType: "openai",
      baseUrl: "http://[::1]:11434",
      models: [],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid baseUrl");
    await app.close();
  });

  it("rejects non-.1 loopback baseUrl", async () => {
    const app = await makeApp();
    const res = await authedRequest(app.server).post("/compute/providers").send({
      id: "loop2",
      displayName: "Loop2",
      providerType: "openai",
      baseUrl: "http://127.0.0.2:11434",
      models: [],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid baseUrl");
    await app.close();
  });

  // WHATWG URL 会把这些 IPv4-mapped/compatible 形式归一化为 hex，
  // 拦截逻辑必须按 hex 段解析，否则全部绕过
  it.each([
    "http://[::ffff:127.0.0.1]/", // mapped loopback
    "http://[::ffff:169.254.169.254]/", // mapped 云元数据
    "http://[::ffff:7f00:1]/", // hex 形式直接传入
    "http://[::127.0.0.1]/", // compatible loopback
    "http://[::ffff:ac10:fe01]/", // mapped 内网 172.16.254.1
    "http://[::]/", // unspecified
  ])("rejects IPv4-mapped/compatible IPv6 baseUrl: %s", async (baseUrl) => {
    const app = await makeApp();
    const res = await authedRequest(app.server).post("/compute/providers").send({
      id: "v6mapped",
      displayName: "V6Mapped",
      providerType: "openai",
      baseUrl,
      models: [],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid baseUrl");
    await app.close();
  });

  it("allows a public IPv4-mapped IPv6 baseUrl (不误伤)", async () => {
    const app = await makeApp();
    const res = await authedRequest(app.server).post("/compute/providers").send({
      id: "v6public",
      displayName: "V6Public",
      providerType: "openai",
      baseUrl: "http://[::ffff:8.8.8.8]/",
      models: [],
    });
    expect(res.status).toBe(200);
    await app.close();
  });

  it("allows valid http/https external baseUrl", async () => {
    const app = await makeApp();
    const res = await authedRequest(app.server).post("/compute/providers").send({
      id: "external",
      displayName: "External",
      providerType: "openai",
      baseUrl: "https://api.openai.com/v1",
      models: [],
    });
    expect(res.status).toBe(200);
    expect(res.body.baseUrl).toBe("https://api.openai.com/v1");
    await app.close();
  });

  it("rejects hostname resolving to private IPv4 (SSRF DNS 解析拦截)", async () => {
    lookupMock.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
    const app = await makeApp();
    const res = await authedRequest(app.server).post("/compute/providers").send({
      id: "dns-internal",
      displayName: "Dns Internal",
      providerType: "openai",
      baseUrl: "https://internal.example.com",
      models: [],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid baseUrl");
    expect(lookupMock).toHaveBeenCalledWith("internal.example.com", {
      all: true,
      verbatim: false,
    });
    await app.close();
  });

  it("rejects hostname with any private record (多记录任一内网即拒，AAAA 同判定)", async () => {
    lookupMock.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "fd00::1", family: 6 },
    ]);
    const app = await makeApp();
    const res = await authedRequest(app.server).post("/compute/providers").send({
      id: "dns-mixed",
      displayName: "Dns Mixed",
      providerType: "openai",
      baseUrl: "https://mixed.example.com",
      models: [],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid baseUrl");
    await app.close();
  });

  it("allows hostname resolving to public A + AAAA records only", async () => {
    lookupMock.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ]);
    const app = await makeApp();
    const res = await authedRequest(app.server).post("/compute/providers").send({
      id: "dns-public",
      displayName: "Dns Public",
      providerType: "openai",
      baseUrl: "https://public.example.com",
      models: [],
    });
    expect(res.status).toBe(200);
    await app.close();
  });

  it("allows + warns when DNS resolution fails (失败语义：放行 + warn)", async () => {
    lookupMock.mockRejectedValue(
      Object.assign(new Error("getaddrinfo ENOTFOUND offline.example.com"), { code: "ENOTFOUND" }),
    );
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const app = await makeApp();
      const res = await authedRequest(app.server).post("/compute/providers").send({
        id: "dns-fail",
        displayName: "Dns Fail",
        providerType: "openai",
        baseUrl: "https://offline.example.com",
        models: [],
      });
      expect(res.status).toBe(200);
      const calls = warnSpy.mock.calls.filter((c) =>
        String(c[1]).includes("baseUrl DNS resolution failed"),
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]![0]).toMatchObject({
        hostname: "offline.example.com",
        errCode: "ENOTFOUND",
      });
      await app.close();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("PUT baseUrl 同样走 DNS 解析校验（解析到内网 → 400，原值保留）", async () => {
    const app = await makeApp();
    await authedRequest(app.server).post("/compute/providers").send({
      id: "dns-put",
      displayName: "Dns Put",
      providerType: "openai",
      baseUrl: "https://api.openai.com/v1",
      models: [],
    });
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const res = await authedRequest(app.server)
      .put("/compute/providers/dns-put")
      .send({ baseUrl: "https://sneaky.example.com" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid baseUrl");
    const config = await context.configRepository.load();
    expect(config.providers[0].baseUrl).toBe("https://api.openai.com/v1");
    await app.close();
  });

  it("IP 字面量 baseUrl 不触发 DNS 解析（既有路径不受影响）", async () => {
    const app = await makeApp();
    const res = await authedRequest(app.server).post("/compute/providers").send({
      id: "ip-literal",
      displayName: "Ip Literal",
      providerType: "openai",
      baseUrl: "http://8.8.8.8:8080",
      models: [],
    });
    expect(res.status).toBe(200);
    expect(lookupMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("accepts and persists apiMode on create/update", async () => {
    const app = await makeApp();
    const createRes = await authedRequest(app.server).post("/compute/providers").send({
      id: "ds",
      displayName: "DeepSeek",
      providerType: "openai",
      baseUrl: "https://api.deepseek.com",
      apiMode: "responses",
      models: [],
    });
    expect(createRes.status).toBe(200);
    expect(createRes.body.apiMode).toBe("responses");

    const updateRes = await authedRequest(app.server)
      .put("/compute/providers/ds")
      .send({ apiMode: "anthropic" });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.apiMode).toBe("anthropic");

    const config = await context.configRepository.load();
    expect(config.providers[0].apiMode).toBe("anthropic");
    await app.close();
  });

  it("rejects invalid apiMode on create/update", async () => {
    const app = await makeApp();
    const createRes = await authedRequest(app.server).post("/compute/providers").send({
      id: "bad",
      displayName: "Bad",
      baseUrl: "https://api.deepseek.com",
      apiMode: "grpc",
      models: [],
    });
    expect(createRes.status).toBe(400);
    expect(createRes.body.error).toContain("apiMode");

    await authedRequest(app.server).post("/compute/providers").send({
      id: "ok",
      displayName: "Ok",
      baseUrl: "https://api.deepseek.com",
      models: [],
    });
    const updateRes = await authedRequest(app.server)
      .put("/compute/providers/ok")
      .send({ apiMode: "websocket" });
    expect(updateRes.status).toBe(400);
    expect(updateRes.body.error).toContain("apiMode");
    await app.close();
  });

  it("tests anthropic provider through x-api-key models endpoint", async () => {
    const app = await makeApp();
    await authedRequest(app.server).post("/compute/providers").send({
      id: "claude",
      displayName: "Claude",
      providerType: "openai",
      baseUrl: "https://api.deepseek.com/anthropic",
      apiKey: "sk-anthropic",
      apiMode: "anthropic",
      models: [],
    });

    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), init });
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              data: [{ id: "claude-3-5-sonnet-20241022", display_name: "Claude 3.5 Sonnet" }],
            }),
        } as unknown as Response);
      }),
    );

    const res = await authedRequest(app.server).post("/compute/providers/claude/test");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.discovered).toEqual([
      { id: "claude-3-5-sonnet-20241022", displayName: "claude-3-5-sonnet-20241022", modelType: "llm" },
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.deepseek.com/anthropic/v1/models");
    expect(calls[0].init?.method ?? "GET").toBe("GET");
    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get("x-api-key")).toBe("sk-anthropic");
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    // R3（review）：anthropic 路径 fetch 必须带超时信号，不能无限悬挂
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
    await app.close();
  });

  it("normalizes anthropic models url from root baseUrl", async () => {
    const app = await makeApp();
    await authedRequest(app.server).post("/compute/providers").send({
      id: "claude-root",
      displayName: "Claude Root",
      providerType: "openai",
      baseUrl: "https://api.deepseek.com",
      apiKey: "sk-anthropic",
      apiMode: "anthropic",
      models: [],
    });

    const calls: Array<{ url: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        calls.push({ url: String(input) });
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ data: [] }),
        } as unknown as Response);
      }),
    );

    const res = await authedRequest(app.server).post("/compute/providers/claude-root/test");
    expect(res.status).toBe(200);
    expect(calls[0].url).toBe("https://api.deepseek.com/anthropic/v1/models");
    await app.close();
  });

  it("returns 502 with upstream 404 detail when anthropic provider has no models endpoint", async () => {
    const app = await makeApp();
    await authedRequest(app.server).post("/compute/providers").send({
      id: "claude-no-models",
      displayName: "Claude No Models",
      providerType: "openai",
      baseUrl: "https://api.deepseek.com/anthropic",
      apiKey: "sk-anthropic",
      apiMode: "anthropic",
      models: [],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 404,
          json: () => Promise.resolve({ error: { message: "not found" } }),
        } as unknown as Response),
      ),
    );

    const res = await authedRequest(app.server).post("/compute/providers/claude-no-models/test");
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("Test connection failed: 上游返回 404（无 models 端点）");
    await app.close();
  });

  it.each([401, 403])("returns 502 with auth wording for anthropic HTTP %s", async (status) => {
    const app = await makeApp();
    await authedRequest(app.server).post("/compute/providers").send({
      id: `claude-auth-${status}`,
      displayName: "Claude Auth",
      providerType: "openai",
      baseUrl: "https://api.deepseek.com/anthropic",
      apiKey: "sk-bad",
      apiMode: "anthropic",
      models: [],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status,
          json: () => Promise.resolve({ error: { message: "authentication error" } }),
          text: () => Promise.resolve(""),
        } as unknown as Response),
      ),
    );

    const res = await authedRequest(app.server).post(`/compute/providers/claude-auth-${status}/test`);
    expect(res.status).toBe(502);
    expect(res.body.error).toBe(`Test connection failed: 上游返回 ${status}（密钥无效或权限不足）`);
    await app.close();
  });

  it("returns 502 with network wording when anthropic fetch rejects", async () => {
    const app = await makeApp();
    await authedRequest(app.server).post("/compute/providers").send({
      id: "claude-net",
      displayName: "Claude Net",
      providerType: "openai",
      baseUrl: "https://api.deepseek.com/anthropic",
      apiKey: "sk-anthropic",
      apiMode: "anthropic",
      models: [],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("fetch failed"))),
    );

    const res = await authedRequest(app.server).post("/compute/providers/claude-net/test");
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("Test connection failed: 网络错误（无法连接上游）");
    await app.close();
  });

  it("A2/F2：test-connection 失败日志只落固定分类文案 + status/kind，不落 errMessage 原文", async () => {
    const app = await makeApp();
    await authedRequest(app.server).post("/compute/providers").send({
      id: "claude-leak",
      displayName: "Claude Leak",
      providerType: "openai",
      baseUrl: "https://api.deepseek.com/anthropic",
      apiKey: "sk-leak",
      apiMode: "anthropic",
      models: [],
    });
    // 上游错误体可能回显 Authorization/密钥：err 对象本体不得进日志
    const upstream = Object.assign(
      new Error("上游错误体含 Authorization: Bearer sk-super-secret-123456"),
      { status: 502 },
    );
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(upstream)));
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    try {
      const res = await authedRequest(app.server).post("/compute/providers/claude-leak/test");
      expect(res.status).toBe(502);
      expect(res.body.error).not.toContain("sk-super-secret");
      const calls = errorSpy.mock.calls.filter((c) =>
        String(c[1]).includes("test connection failed"),
      );
      expect(calls).toHaveLength(1);
      const fields = calls[0]![0] as Record<string, unknown>;
      expect(fields).toMatchObject({
        errorSummary: "上游返回 502",
        statusCode: 502,
        providerId: "claude-leak",
        apiMode: "anthropic",
      });
      // 隐私底线：密钥片段不得出现在任何日志字段（含序列化后的整体）
      expect(fields).not.toHaveProperty("err");
      expect(fields).not.toHaveProperty("errMessage");
      expect(JSON.stringify(fields)).not.toContain("sk-super-secret");
    } finally {
      errorSpy.mockRestore();
    }
    await app.close();
  });

  it("returns 502 with protocol wording when anthropic 2xx body is not JSON", async () => {
    const app = await makeApp();
    await authedRequest(app.server).post("/compute/providers").send({
      id: "claude-html",
      displayName: "Claude Html",
      providerType: "openai",
      baseUrl: "https://api.deepseek.com/anthropic",
      apiKey: "sk-anthropic",
      apiMode: "anthropic",
      models: [],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.reject(new SyntaxError("Unexpected token '<'")),
        } as unknown as Response),
      ),
    );

    const res = await authedRequest(app.server).post("/compute/providers/claude-html/test");
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("Test connection failed: 上游响应格式错误（非 JSON 或缺少 data 列表）");
    await app.close();
  });

  it("returns 502 with auth wording when OpenAI SDK path gets 401", async () => {
    const OpenAI = (await import("openai")).default as unknown as {
      __setListImpl(fn: (() => Promise<unknown>) | null): void;
    };
    OpenAI.__setListImpl(() => {
      const err = new Error("401 Unauthorized") as Error & { status: number };
      err.status = 401;
      throw err;
    });
    try {
      const app = await makeApp();
      await authedRequest(app.server).post("/compute/providers").send({
        id: "openai-401",
        displayName: "OpenAI 401",
        providerType: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-bad",
        apiMode: "chat_completions",
        models: [],
      });
      const res = await authedRequest(app.server).post("/compute/providers/openai-401/test");
      expect(res.status).toBe(502);
      expect(res.body.error).toBe("Test connection failed: 上游返回 401（密钥无效或权限不足）");
      await app.close();
    } finally {
      OpenAI.__setListImpl(null);
    }
  });

  it("persists requestTimeout/maxRetries on create and update", async () => {
    const app = await makeApp();
    const createRes = await authedRequest(app.server).post("/compute/providers").send({
      id: "timeout",
      displayName: "Timeout Provider",
      providerType: "openai",
      baseUrl: "https://api.openai.com/v1",
      requestTimeout: 120_000,
      maxRetries: 3,
      models: [],
    });
    expect(createRes.status).toBe(200);
    expect(createRes.body.requestTimeout).toBe(120_000);
    expect(createRes.body.maxRetries).toBe(3);

    const updateRes = await authedRequest(app.server)
      .put("/compute/providers/timeout")
      .send({ maxRetries: 5 });
    expect(updateRes.status).toBe(200);
    // PUT 缺省字段不改现状
    expect(updateRes.body.requestTimeout).toBe(120_000);
    expect(updateRes.body.maxRetries).toBe(5);

    const config = await context.configRepository.load();
    expect(config.providers[0].requestTimeout).toBe(120_000);
    expect(config.providers[0].maxRetries).toBe(5);
    await app.close();
  });

  it.each([
    ["requestTimeout", 0],
    ["requestTimeout", -1],
    ["requestTimeout", 600_001],
    ["requestTimeout", "abc"],
    ["maxRetries", 0],
    ["maxRetries", 11],
    ["maxRetries", -3],
  ])("rejects invalid %s on create: %j", async (field, value) => {
    const app = await makeApp();
    const res = await authedRequest(app.server).post("/compute/providers").send({
      id: "bad-option",
      displayName: "Bad Option",
      providerType: "openai",
      baseUrl: "https://api.openai.com/v1",
      models: [],
      [field]: value,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain(field);
    await app.close();
  });

  it("rejects invalid requestTimeout/maxRetries on update", async () => {
    const app = await makeApp();
    await authedRequest(app.server).post("/compute/providers").send({
      id: "update-bad",
      displayName: "Update Bad",
      providerType: "openai",
      baseUrl: "https://api.openai.com/v1",
      models: [],
    });

    const timeoutRes = await authedRequest(app.server)
      .put("/compute/providers/update-bad")
      .send({ requestTimeout: -1 });
    expect(timeoutRes.status).toBe(400);
    expect(timeoutRes.body.error).toContain("requestTimeout");

    const retriesRes = await authedRequest(app.server)
      .put("/compute/providers/update-bad")
      .send({ maxRetries: 12 });
    expect(retriesRes.status).toBe(400);
    expect(retriesRes.body.error).toContain("maxRetries");
    await app.close();
  });

  it("A4：POST providers 的 models 逐型号同口径校验——非法字段 400 不落库", async () => {
    const app = await makeApp();
    const base = {
      id: "bad-models",
      displayName: "Bad Models",
      providerType: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
    };
    const cases: Array<{ models: unknown; field: string }> = [
      { models: [{ id: "m1", displayName: "M1", modelType: "llm", contextWindow: "abc" }], field: "contextWindow" },
      { models: [{ id: "m2", displayName: "M2", modelType: "llm", apiMode: "grpc" }], field: "apiMode" },
      { models: [{ id: "m3", displayName: "M3", modelType: "tts" }], field: "modelType" },
      { models: [{ id: "   ", displayName: "M4", modelType: "llm" }], field: "id" },
      { models: [{ id: "m5", displayName: "   ", modelType: "llm" }], field: "displayName" },
      { models: [{ id: "m6", displayName: "M6", modelType: "llm", contextWindow: 0 }], field: "contextWindow" },
      { models: "not-an-array", field: "models" },
      { models: [null], field: "models" },
    ];
    for (const { models, field } of cases) {
      const res = await authedRequest(app.server).post("/compute/providers").send({
        ...base,
        models,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain(field);
    }
    const listRes = await authedRequest(app.server).get("/compute/providers");
    expect(listRes.body).toHaveLength(0);
    await app.close();
  });

  it("P3：POST providers 的 models 数组内重复 id → 400 不落库", async () => {
    const app = await makeApp();
    const res = await authedRequest(app.server).post("/compute/providers").send({
      id: "dup-models",
      displayName: "Dup Models",
      providerType: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      models: [
        { id: "gpt-4o", displayName: "GPT-4o", modelType: "llm" },
        { id: "gpt-4o", displayName: "GPT-4o 2", modelType: "llm" },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Duplicate model id");
    const listRes = await authedRequest(app.server).get("/compute/providers");
    expect(listRes.body).toHaveLength(0);
    await app.close();
  });

  it("A4：POST providers 合法 models 数组按白名单构造落库（displayName 缺省回退 id）", async () => {
    const app = await makeApp();
    const res = await authedRequest(app.server).post("/compute/providers").send({
      id: "ok-models",
      displayName: "Ok Models",
      providerType: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      models: [
        {
          id: "gpt-4o",
          displayName: "GPT-4o",
          modelType: "llm",
          contextWindow: 128_000,
          maxOutputTokens: 8_192,
          supportsToolCalling: true,
        },
        { id: "text-embed", modelType: "embedding" },
      ],
    });
    expect(res.status).toBe(200);
    const config = await context.configRepository.load();
    expect(config.providers[0].models).toEqual([
      expect.objectContaining({
        id: "gpt-4o",
        displayName: "GPT-4o",
        modelType: "llm",
        contextWindow: 128_000,
        maxOutputTokens: 8_192,
        supportsToolCalling: true,
      }),
      expect.objectContaining({ id: "text-embed", displayName: "text-embed", modelType: "embedding" }),
    ]);
    await app.close();
  });

  it("rejects model without id", async () => {
    const app = await makeApp();
    await authedRequest(app.server).post("/compute/providers").send({
      id: "models",
      displayName: "Models",
      providerType: "openai",
      baseUrl: "https://api.openai.com/v1",
      models: [],
    });
    const res = await authedRequest(app.server)
      .post("/compute/providers/models/models")
      .send({ displayName: "No Id", modelType: "llm" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("id");
    await app.close();
  });

  it("rejects empty-string model id", async () => {
    const app = await makeApp();
    await authedRequest(app.server).post("/compute/providers").send({
      id: "models-empty",
      displayName: "Models Empty",
      providerType: "openai",
      baseUrl: "https://api.openai.com/v1",
      models: [],
    });
    const res = await authedRequest(app.server)
      .post("/compute/providers/models-empty/models")
      .send({ id: "   ", displayName: "Blank", modelType: "llm" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("id");
    await app.close();
  });

  it("returns 409 for duplicate model id", async () => {
    const app = await makeApp();
    await authedRequest(app.server).post("/compute/providers").send({
      id: "models-dup",
      displayName: "Models Dup",
      providerType: "openai",
      baseUrl: "https://api.openai.com/v1",
      models: [{ id: "gpt-4o", displayName: "GPT-4o", modelType: "llm" }],
    });
    const res = await authedRequest(app.server)
      .post("/compute/providers/models-dup/models")
      .send({ id: "gpt-4o", displayName: "Duplicate", modelType: "llm" });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("already exists");
    await app.close();
  });

  it("rejects invalid modelType", async () => {
    const app = await makeApp();
    await authedRequest(app.server).post("/compute/providers").send({
      id: "models-type",
      displayName: "Models Type",
      providerType: "openai",
      baseUrl: "https://api.openai.com/v1",
      models: [],
    });
    const res = await authedRequest(app.server)
      .post("/compute/providers/models-type/models")
      .send({ id: "weird", displayName: "Weird", modelType: "tts" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("modelType");
    await app.close();
  });

  it.each([
    ["contextWindow", 0],
    ["contextWindow", -10],
    ["contextWindow", 1.5],
    ["contextWindow", "big"],
    ["maxOutputTokens", 0],
    ["supportsReasoning", "yes"],
    ["supportsToolCalling", 1],
    ["supportsMultimodal", null],
  ])("rejects invalid model capability %s: %j", async (field, value) => {
    const app = await makeApp();
    await authedRequest(app.server).post("/compute/providers").send({
      id: "models-capability",
      displayName: "Models Capability",
      providerType: "openai",
      baseUrl: "https://api.openai.com/v1",
      models: [],
    });
    const res = await authedRequest(app.server)
      .post("/compute/providers/models-capability/models")
      .send({ id: "cap-model", modelType: "llm", [field]: value });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain(field);
    await app.close();
  });

  it("adds model with displayName default and capability fields", async () => {
    const app = await makeApp();
    await authedRequest(app.server).post("/compute/providers").send({
      id: "models-full",
      displayName: "Models Full",
      providerType: "openai",
      baseUrl: "https://api.openai.com/v1",
      models: [],
    });
    const res = await authedRequest(app.server)
      .post("/compute/providers/models-full/models")
      .send({
        id: "claude-3-5-sonnet",
        modelType: "llm",
        contextWindow: 200_000,
        maxOutputTokens: 8_192,
        supportsReasoning: true,
        supportsToolCalling: true,
        supportsMultimodal: false,
      });
    expect(res.status).toBe(200);
    expect(res.body.displayName).toBe("claude-3-5-sonnet");
    expect(res.body.contextWindow).toBe(200_000);
    expect(res.body.maxOutputTokens).toBe(8_192);
    expect(res.body.supportsReasoning).toBe(true);
    expect(res.body.supportsToolCalling).toBe(true);
    expect(res.body.supportsMultimodal).toBe(false);

    const config = await context.configRepository.load();
    expect(config.providers[0].models[0]).toMatchObject({
      id: "claude-3-5-sonnet",
      displayName: "claude-3-5-sonnet",
      modelType: "llm",
      contextWindow: 200_000,
      maxOutputTokens: 8_192,
      supportsReasoning: true,
      supportsToolCalling: true,
      supportsMultimodal: false,
    });
    await app.close();
  });

  it("accepts and persists model apiMode on POST/PUT", async () => {
    const app = await makeApp();
    await authedRequest(app.server).post("/compute/providers").send({
      id: "model-apimode",
      displayName: "Model ApiMode",
      providerType: "openai",
      baseUrl: "https://api.deepseek.com",
      models: [],
    });

    const addRes = await authedRequest(app.server)
      .post("/compute/providers/model-apimode/models")
      .send({
        id: "deepseek-v4-flash",
        modelType: "llm",
        apiMode: "responses",
      });
    expect(addRes.status).toBe(200);
    expect(addRes.body.apiMode).toBe("responses");

    const updateRes = await authedRequest(app.server)
      .put("/compute/providers/model-apimode/models/deepseek-v4-flash")
      .send({ apiMode: "anthropic" });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.apiMode).toBe("anthropic");

    const config = await context.configRepository.load();
    expect(config.providers[0].models[0].apiMode).toBe("anthropic");
    await app.close();
  });

  it("R4：PUT apiMode:null 显式清除型号覆盖，回退 provider 级", async () => {
    const app = await makeApp();
    await authedRequest(app.server).post("/compute/providers").send({
      id: "model-apimode-clear",
      displayName: "Model ApiMode Clear",
      providerType: "openai",
      baseUrl: "https://api.deepseek.com",
      apiMode: "chat_completions",
      models: [],
    });
    await authedRequest(app.server)
      .post("/compute/providers/model-apimode-clear/models")
      .send({ id: "deepseek-v4-flash", modelType: "llm", apiMode: "responses" });

    const clearRes = await authedRequest(app.server)
      .put("/compute/providers/model-apimode-clear/models/deepseek-v4-flash")
      .send({ apiMode: null });
    expect(clearRes.status).toBe(200);
    expect(clearRes.body.apiMode).toBeUndefined();

    const config = await context.configRepository.load();
    const model = config.providers[0].models[0];
    expect(model).not.toHaveProperty("apiMode");
    // 清除后回退 provider 级口径
    expect(config.providers[0].apiMode).toBe("chat_completions");
    await app.close();
  });

  it("rejects invalid model apiMode on POST/PUT", async () => {
    const app = await makeApp();
    await authedRequest(app.server).post("/compute/providers").send({
      id: "model-apimode-bad",
      displayName: "Model ApiMode Bad",
      providerType: "openai",
      baseUrl: "https://api.deepseek.com",
      models: [{ id: "deepseek-v4-flash", displayName: "Flash", modelType: "llm" }],
    });

    const addRes = await authedRequest(app.server)
      .post("/compute/providers/model-apimode-bad/models")
      .send({ id: "deepseek-v3", modelType: "llm", apiMode: "grpc" });
    expect(addRes.status).toBe(400);
    expect(addRes.body.error).toContain("apiMode");

    const updateRes = await authedRequest(app.server)
      .put("/compute/providers/model-apimode-bad/models/deepseek-v4-flash")
      .send({ apiMode: "websocket" });
    expect(updateRes.status).toBe(400);
    expect(updateRes.body.error).toContain("apiMode");

    const config = await context.configRepository.load();
    expect(config.providers[0].models[0]).not.toHaveProperty("apiMode");
    await app.close();
  });

  it("updates model via whitelist with all editable fields", async () => {
    const app = await makeApp();
    await authedRequest(app.server).post("/compute/providers").send({
      id: "put-models",
      displayName: "Put Models",
      providerType: "openai",
      baseUrl: "https://api.openai.com/v1",
      models: [{ id: "gpt-4o", displayName: "GPT-4o", modelType: "llm" }],
    });

    const res = await authedRequest(app.server).put("/compute/providers/put-models/models/gpt-4o").send({
      displayName: "GPT-4o Updated",
      modelType: "embedding",
      contextWindow: 200_000,
      maxOutputTokens: 8_192,
      supportsReasoning: true,
      supportsToolCalling: false,
      supportsMultimodal: true,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: "gpt-4o",
      displayName: "GPT-4o Updated",
      modelType: "embedding",
      contextWindow: 200_000,
      maxOutputTokens: 8_192,
      supportsReasoning: true,
      supportsToolCalling: false,
      supportsMultimodal: true,
    });

    const config = await context.configRepository.load();
    expect(config.providers[0].models[0]).toMatchObject({
      id: "gpt-4o",
      displayName: "GPT-4o Updated",
      modelType: "embedding",
      contextWindow: 200_000,
      maxOutputTokens: 8_192,
      supportsReasoning: true,
      supportsToolCalling: false,
      supportsMultimodal: true,
    });
    await app.close();
  });

  it.each([
    ["modelType", "tts"],
    ["contextWindow", 0],
    ["contextWindow", -10],
    ["contextWindow", 1.5],
    ["contextWindow", "big"],
    ["maxOutputTokens", 0],
    ["supportsReasoning", "yes"],
    ["supportsToolCalling", 1],
    ["supportsMultimodal", null],
    ["displayName", ""],
    ["displayName", "   "],
    ["displayName", 123],
  ])("rejects invalid PUT model field %s: %j", async (field, value) => {
    const app = await makeApp();
    await authedRequest(app.server).post("/compute/providers").send({
      id: "put-invalid",
      displayName: "Put Invalid",
      providerType: "openai",
      baseUrl: "https://api.openai.com/v1",
      models: [{ id: "gpt-4o", displayName: "GPT-4o", modelType: "llm" }],
    });

    const res = await authedRequest(app.server)
      .put("/compute/providers/put-invalid/models/gpt-4o")
      .send({ [field]: value });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain(field);
    await app.close();
  });

  it("rejects id change via PUT", async () => {
    const app = await makeApp();
    await authedRequest(app.server).post("/compute/providers").send({
      id: "put-id",
      displayName: "Put Id",
      providerType: "openai",
      baseUrl: "https://api.openai.com/v1",
      models: [{ id: "gpt-4o", displayName: "GPT-4o", modelType: "llm" }],
    });

    const res = await authedRequest(app.server)
      .put("/compute/providers/put-id/models/gpt-4o")
      .send({ id: "gpt-5" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("id");

    const config = await context.configRepository.load();
    expect(config.providers[0].models[0].id).toBe("gpt-4o");
    await app.close();
  });

  it("allows id equal to path modelId and ignores unknown fields", async () => {
    const app = await makeApp();
    await authedRequest(app.server).post("/compute/providers").send({
      id: "put-unknown",
      displayName: "Put Unknown",
      providerType: "openai",
      baseUrl: "https://api.openai.com/v1",
      models: [{ id: "gpt-4o", displayName: "GPT-4o", modelType: "llm" }],
    });

    const res = await authedRequest(app.server)
      .put("/compute/providers/put-unknown/models/gpt-4o")
      .send({ id: "gpt-4o", displayName: "Renamed", junk: "x" });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("gpt-4o");
    expect(res.body.displayName).toBe("Renamed");
    expect(res.body).not.toHaveProperty("junk");

    const config = await context.configRepository.load();
    expect(config.providers[0].models[0].id).toBe("gpt-4o");
    expect(config.providers[0].models[0]).not.toHaveProperty("junk");
    await app.close();
  });
});
