import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

  it("A2：test-connection 失败日志收敛为 err.message + statusCode，不落 err 对象本体", async () => {
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
        errMessage: "上游错误体含 Authorization: Bearer sk-super-secret-123456",
        statusCode: 502,
        providerId: "claude-leak",
        apiMode: "anthropic",
      });
      expect(fields).not.toHaveProperty("err");
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
