import { describe, it, expect, vi, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  LLMEvent,
  LLMChatParams,
  LLMProvider,
  LLMProviderProtocol,
} from "../../src/provider/types.js";
import { ResilientLLMProvider } from "../../src/provider/resilient.js";
import { ConfigRepository } from "../../src/config/repository.js";
import { restoreDataDir } from "../helpers/env.js";
import type { ProviderConfig } from "@mindcloud/shared";
import {
  ModelApiModeRouter,
  hasModelApiModeOverride,
} from "../../src/provider/protocols/index.js";

function stubAdapter(name: string): LLMProvider {
  const chat = vi.fn((params: LLMChatParams): AsyncIterable<LLMEvent> => {
    return (async function* () {
      yield { type: "text.delta", delta: `${name}:${params.model}` };
      yield { type: "step.end" };
    })();
  });
  return {
    name,
    protocol: name as LLMProviderProtocol,
    supportsModel: vi.fn(() => true),
    chat,
  };
}

async function collect(provider: LLMProvider, params: LLMChatParams): Promise<LLMEvent[]> {
  const events: LLMEvent[] = [];
  for await (const event of provider.chat(params)) events.push(event);
  return events;
}

function messagesFor(model: string): LLMChatParams {
  return {
    model,
    messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "hi" }], createdAt: new Date().toISOString() }],
  };
}

describe("ModelApiModeRouter（型号级 apiMode 覆盖）", () => {
  it("型号级覆盖生效：provider=chat_completions + 型号 apiMode=responses → 该型号走 responses 适配器", async () => {
    const created: Array<{ providerId: string; apiMode: string | undefined; adapter: LLMProvider }> = [];
    const createAdapter = vi.fn(
      (providerId: string, apiMode: string | undefined): LLMProvider => {
        const adapter = stubAdapter(apiMode ?? "chat_completions");
        created.push({ providerId, apiMode, adapter });
        return adapter;
      },
    );
    const router = new ModelApiModeRouter({
      providerId: "ds",
      provider: {
        apiMode: "chat_completions",
        baseUrl: "https://api.example.com",
        models: [
          {
            id: "deepseek-v4-flash",
            displayName: "DeepSeek Flash",
            modelType: "llm",
            apiMode: "responses",
          },
        ],
      },
      defaultModel: "deepseek-v4-flash",
      createAdapter,
    });

    const events = await collect(router, messagesFor("deepseek-v4-flash"));

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ providerId: "ds", apiMode: "responses" });
    expect(created[0]!.adapter.chat).toHaveBeenCalledWith(
      expect.objectContaining({ model: "deepseek-v4-flash" }),
    );
    expect(events).toMatchObject([
      { type: "text.delta", delta: "responses:deepseek-v4-flash" },
      { type: "step.end" },
    ]);
  });

  it("缺省回退：型号无 apiMode → 走 provider 级适配器，多型号共享单实例（现状不变）", async () => {
    const created: Array<{ providerId: string; apiMode: string | undefined; adapter: LLMProvider }> = [];
    const createAdapter = vi.fn(
      (providerId: string, apiMode: string | undefined): LLMProvider => {
        const adapter = stubAdapter(apiMode ?? "chat_completions");
        created.push({ providerId, apiMode, adapter });
        return adapter;
      },
    );
    const router = new ModelApiModeRouter({
      providerId: "p",
      provider: {
        apiMode: "chat_completions",
        baseUrl: "https://api.example.com",
        models: [
          { id: "gpt-4o", displayName: "GPT-4o", modelType: "llm" },
          { id: "gpt-4o-mini", displayName: "GPT-4o mini", modelType: "llm" },
        ],
      },
      defaultModel: "gpt-4o",
      createAdapter,
    });

    expect(router.protocol).toBe("chat_completions");
    await collect(router, messagesFor("gpt-4o"));
    await collect(router, messagesFor("gpt-4o-mini"));

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ providerId: "p", apiMode: "chat_completions" });
    expect((created[0]!.adapter.chat as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].model)).toEqual([
      "gpt-4o",
      "gpt-4o-mini",
    ]);
  });

  it("缺省回退：型号无 apiMode → 沿用 provider 级 anthropic 适配器", async () => {
    const created: Array<{ apiMode: string | undefined }> = [];
    const router = new ModelApiModeRouter({
      providerId: "claude",
      provider: {
        apiMode: "anthropic",
        baseUrl: "https://api.example.com/anthropic",
        models: [{ id: "claude-3-5", displayName: "Claude", modelType: "llm" }],
      },
      defaultModel: "claude-3-5",
      createAdapter: (providerId, apiMode) => {
        created.push({ apiMode });
        return stubAdapter(apiMode ?? "chat_completions");
      },
    });

    expect(router.protocol).toBe("anthropic");
    await collect(router, messagesFor("claude-3-5"));
    expect(created).toEqual([{ apiMode: "anthropic" }]);
  });

  it("同 provider 双协议并存：两个型号各指 chat/responses → 各自走各自适配器互不串", async () => {
    const created: Array<{ apiMode: string | undefined; adapter: LLMProvider }> = [];
    const router = new ModelApiModeRouter({
      providerId: "p",
      provider: {
        apiMode: "chat_completions",
        baseUrl: "https://api.example.com",
        models: [
          { id: "gpt-4o", displayName: "GPT-4o", modelType: "llm" },
          { id: "flash", displayName: "Flash", modelType: "llm", apiMode: "responses" },
        ],
      },
      defaultModel: "flash",
      createAdapter: (providerId, apiMode) => {
        const adapter = stubAdapter(apiMode ?? "chat_completions");
        created.push({ apiMode, adapter });
        return adapter;
      },
    });

    await collect(router, messagesFor("gpt-4o"));
    await collect(router, messagesFor("flash"));

    expect(created).toHaveLength(2);
    expect(created.map((c) => c.apiMode)).toEqual(["chat_completions", "responses"]);
    expect(created[0]!.adapter.chat).toHaveBeenCalledTimes(1);
    expect(created[0]!.adapter.chat).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-4o" }),
    );
    expect(created[1]!.adapter.chat).toHaveBeenCalledTimes(1);
    expect(created[1]!.adapter.chat).toHaveBeenCalledWith(
      expect.objectContaining({ model: "flash" }),
    );
    // 双协议并存：缓存键互不串
    expect(created[0]!.adapter).not.toBe(created[1]!.adapter);
  });

  it("protocol() 口径：型号覆盖 responses → responses；resilient 包装下跟随主适配器并保持复位", async () => {
    const router = new ModelApiModeRouter({
      providerId: "ds",
      provider: {
        apiMode: "chat_completions",
        baseUrl: "https://api.example.com",
        models: [
          {
            id: "deepseek-v4-flash",
            displayName: "DeepSeek Flash",
            modelType: "llm",
            apiMode: "responses",
          },
        ],
      },
      defaultModel: "deepseek-v4-flash",
      createAdapter: (_providerId, apiMode) => stubAdapter(apiMode ?? "chat_completions"),
    });
    const resilient = new ResilientLLMProvider(router, { sleep: async () => {} });

    expect(router.protocol).toBe("responses");
    expect(resilient.protocol).toBe("responses");
    const events = await collect(resilient, messagesFor("deepseek-v4-flash"));
    expect(events.at(-1)).toMatchObject({ type: "step.end" });
    // 链结束复位：预检口径仍按主型号生效协议（responses，不是 provider 级默认 chat_completions）
    expect(resilient.protocol).toBe("responses");
  });

  it("hasModelApiModeOverride：有覆盖 true / 无覆盖 false", () => {
    expect(
      hasModelApiModeOverride({
        models: [{ id: "a", displayName: "A", modelType: "llm", apiMode: "responses" }],
      }),
    ).toBe(true);
    expect(
      hasModelApiModeOverride({
        models: [{ id: "a", displayName: "A", modelType: "llm" }],
      }),
    ).toBe(false);
    expect(hasModelApiModeOverride({ models: [] })).toBe(false);
  });

  it("R3：models 字段缺失（手写/旧版 config）按无覆盖处理，不抛 TypeError", () => {
    expect(hasModelApiModeOverride({} as never)).toBe(false);
  });

  it("R3 活配置守卫：resolveProvider 返回缺 models 字段的活配置 → refresh/chat 不 TypeError，回落 provider 级 apiMode", async () => {
    const created: Array<{ apiMode: string | undefined }> = [];
    const router = new ModelApiModeRouter({
      providerId: "ds-live-no-models",
      provider: {
        apiMode: "anthropic",
        baseUrl: "https://api.example.com",
        models: [{ id: "m", displayName: "M", modelType: "llm" }],
      },
      defaultModel: "m",
      // 手写/旧版 config.json：活配置缺 models 字段（类型上必填，运行时可能缺）
      resolveProvider: async () =>
        ({ apiMode: "anthropic", baseUrl: "https://api.example.com" }) as never,
      createAdapter: (_providerId, apiMode) => {
        created.push({ apiMode });
        return stubAdapter(apiMode ?? "chat_completions");
      },
    });

    await router.refresh();
    expect(router.protocol).toBe("anthropic");
    const events = await collect(router, messagesFor("m"));
    expect(events.at(-1)).toMatchObject({ type: "step.end" });
    expect(created).toEqual([{ apiMode: "anthropic" }]);
  });

  it("R1 热更新：型号表加 apiMode 后 Router 下一次 chat 即走 responses（活配置解析，无需重建/重启）", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "router-hot-update-"));
    const originalDataDir = process.env.CLOUDMIND_DATA_DIR;
    process.env.CLOUDMIND_DATA_DIR = tmpDir;
    try {
      const server = await startMockServer((req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (req.url?.startsWith("/responses")) {
          res.end(
            sse(`{"type":"response.output_text.delta","delta":"hi"}`) +
              sse(`{"type":"response.completed","response":{"id":"r1","status":"completed","usage":{"input_tokens":1,"output_tokens":1}}}`),
          );
          return;
        }
        res.end(
          sse(`{"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}`),
        );
      });
      servers.push(server);

      const initialProvider = {
        id: "ds",
        displayName: "DeepSeek",
        providerType: "openai" as const,
        baseUrl: server.url,
        apiKey: "sk-test",
        apiMode: "chat_completions" as const,
        models: [
          { id: "deepseek-chat", displayName: "Chat", modelType: "llm" as const },
          { id: "deepseek-v4-flash", displayName: "Flash", modelType: "llm" as const },
        ],
      };
      const initial = {
        providers: [initialProvider],
        settings: {
          memory: { compactThreshold: 0.8, keepRecent: 3, hotMemoryLimit: 10, warmMemoryLimit: 20 },
        },
      };
      await fs.writeFile(path.join(tmpDir, "config.json"), JSON.stringify(initial), "utf-8");

      const configRepo = new ConfigRepository();
      const router = new ModelApiModeRouter({
        providerId: "ds",
        provider: initialProvider,
        defaultModel: "deepseek-v4-flash",
        resolveProvider: async () =>
          (await configRepo.load()).providers.find((p) => p.id === "ds"),
        getConfigFileStamp: () => configRepo.getConfigFileStamp(),
      });

      await collect(router, messagesFor("deepseek-v4-flash"));
      expect(router.protocol).toBe("chat_completions");
      expect(server.requests.map((r) => r.url)).toEqual(["/chat/completions"]);

      // 模拟 REST PUT：给 flash 加 apiMode=responses（configRepo load→mutate→save 与 compute 路由同语义）
      const config = await configRepo.load();
      const flash = config.providers
        .find((p) => p.id === "ds")!
        .models.find((m) => m.id === "deepseek-v4-flash")!;
      flash.apiMode = "responses";
      await configRepo.save(config);

      // runTurn 预检前会调 refresh：协议口径立即新（无需先 chat）
      await router.refresh();
      expect(router.protocol).toBe("responses");

      // 下一次 chat 即走新协议，不需要重建 Router/重启
      await collect(router, messagesFor("deepseek-v4-flash"));
      expect(server.requests.map((r) => r.url)).toEqual(["/chat/completions", "/responses"]);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
      restoreDataDir(originalDataDir);
    }
  });

  it("R1/R4：models 同引用变更后下一次 chat 按新生效 apiMode 路由；清除覆盖回落 provider 级", async () => {
    const created: Array<{ apiMode: string | undefined }> = [];
    const provider: Pick<
      ProviderConfig,
      "apiMode" | "models" | "apiKey" | "baseUrl" | "requestTimeout"
    > = {
      apiMode: "chat_completions",
      baseUrl: "https://api.example.com",
      models: [
        { id: "flash", displayName: "Flash", modelType: "llm", apiMode: "responses" },
      ],
    };
    const router = new ModelApiModeRouter({
      providerId: "ds",
      provider,
      defaultModel: "flash",
      createAdapter: (_providerId, apiMode) => {
        created.push({ apiMode });
        return stubAdapter(apiMode ?? "chat_completions");
      },
    });

    await collect(router, messagesFor("flash"));
    expect(created).toEqual([{ apiMode: "responses" }]);
    expect(router.protocol).toBe("responses");

    // 清除覆盖（R4 语义等价物）：下一次 chat 回落 provider 级 chat_completions
    delete provider.models[0].apiMode;
    await collect(router, messagesFor("flash"));
    expect(created).toEqual([{ apiMode: "responses" }, { apiMode: "chat_completions" }]);
    expect(router.protocol).toBe("chat_completions");
  });

  it("R5：defaultModel 与实际 chat 型号不一致时 protocol() 按主型号口径、chat 按实际型号路由", async () => {
    const created: string[] = [];
    const router = new ModelApiModeRouter({
      providerId: "ds-r5",
      provider: {
        apiMode: "chat_completions" as const,
        baseUrl: "https://api.example.com",
        models: [
          { id: "main", displayName: "Main", modelType: "llm" as const },
          { id: "flash", displayName: "Flash", modelType: "llm" as const, apiMode: "responses" as const },
        ],
      },
      defaultModel: "main",
      createAdapter: (_providerId, apiMode) => {
        created.push(apiMode ?? "chat_completions");
        return stubAdapter(apiMode ?? "chat_completions");
      },
    });

    expect(router.protocol).toBe("chat_completions");
    await collect(router, messagesFor("flash"));
    // chat 按实际型号走 responses 适配器
    expect(created).toEqual(["responses"]);
    // 预检口径仍按 defaultModel=main（无覆盖 → provider 级 chat_completions）
    expect(router.protocol).toBe("chat_completions");
  });
});

interface MockServer {
  url: string;
  close: () => Promise<void>;
  requests: Array<{ method: string; url: string }>;
}

function startMockServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<MockServer> {
  return new Promise((resolve, reject) => {
    const requests: MockServer["requests"] = [];
    const server = http.createServer((req, res) => {
      req.resume();
      requests.push({ method: req.method ?? "", url: req.url ?? "" });
      handler(req, res);
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => server.close(() => r())),
        requests,
      });
    });
  });
}

function sse(body: string): string {
  return body
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => `data: ${line}`)
    .join("\n\n") + "\n\n";
}

const servers: MockServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

describe("ModelApiModeRouter 真适配器路由（请求端点）", () => {
  it("覆盖 responses 型号打 /responses；无覆盖型号打 /chat/completions", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (_req.url?.startsWith("/responses")) {
        res.end(
          sse(`{"type":"response.output_text.delta","delta":"hi"}`) +
            sse(`{"type":"response.completed","response":{"id":"r1","status":"completed","usage":{"input_tokens":1,"output_tokens":1}}}`),
        );
        return;
      }
      res.end(
        sse(`{"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}`),
      );
    });
    servers.push(server);

    const router = new ModelApiModeRouter({
      providerId: "ds",
      provider: {
        apiMode: "chat_completions",
        baseUrl: server.url,
        apiKey: "sk-test",
        models: [
          { id: "deepseek-chat", displayName: "Chat", modelType: "llm" },
          { id: "deepseek-v4-flash", displayName: "Flash", modelType: "llm", apiMode: "responses" },
        ],
      },
      defaultModel: "deepseek-v4-flash",
    });

    await collect(router, messagesFor("deepseek-chat"));
    await collect(router, messagesFor("deepseek-v4-flash"));

    expect(server.requests.map((r) => r.url)).toEqual([
      "/chat/completions",
      "/responses",
    ]);
  });
});
