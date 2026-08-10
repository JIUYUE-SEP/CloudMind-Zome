import { describe, it, expect, vi, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type {
  LLMEvent,
  LLMChatParams,
  LLMProvider,
  LLMProviderProtocol,
} from "../../src/provider/types.js";
import { ResilientLLMProvider } from "../../src/provider/resilient.js";
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
