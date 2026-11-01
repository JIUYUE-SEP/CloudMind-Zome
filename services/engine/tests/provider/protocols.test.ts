import { describe, it, expect, vi, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { LLMEvent, LLMChatParams } from "../../src/provider/types.js";
import { ProviderError } from "../../src/provider/errors.js";
import { logger } from "../../src/logger.js";
import { ResilientLLMProvider } from "../../src/provider/resilient.js";
import {
  OpenAICompatibleChatProvider,
  OpenAIResponsesProvider,
  AnthropicMessagesProvider,
  createProtocolProvider,
} from "../../src/provider/protocols/index.js";
import {
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  isRetryableError,
  isTurnAbortedError,
  parseToolArgs,
  resolveIdleTimeoutMs,
  toProviderError,
} from "../../src/provider/protocols/shared.js";

interface MockServer {
  url: string;
  close: () => Promise<void>;
  requests: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: unknown }>;
}

/** 起一个记录请求体、按需返回 SSE/JSON 的 mock server */
function startMockServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<MockServer> {
  return new Promise((resolve, reject) => {
    const requests: MockServer["requests"] = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf-8");
        let body: unknown = raw;
        try {
          body = raw ? JSON.parse(raw) : undefined;
        } catch {
          body = raw;
        }
        requests.push({
          method: req.method ?? "",
          url: req.url ?? "",
          headers: req.headers,
          body,
        });
        handler(req, res);
      });
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

/** 等 http.ServerResponse 的 close 事件，超时返回 fallback（不 sleep，只做竞速） */
function waitClose(res: http.ServerResponse, timeoutMs = 3_000): Promise<boolean> {
  return Promise.race([
    new Promise<boolean>((resolve) => res.once("close", () => resolve(true))),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

async function collect(provider: {
  chat(params: LLMChatParams): AsyncIterable<LLMEvent>;
}, params: LLMChatParams): Promise<{ events: LLMEvent[]; error?: unknown }> {
  const events: LLMEvent[] = [];
  try {
    for await (const event of provider.chat(params)) events.push(event);
    return { events };
  } catch (error) {
    return { events, error };
  }
}

function baseMessages(): LLMChatParams["messages"] {
  const now = new Date().toISOString();
  return [
    { id: "s1", role: "system", content: [{ type: "text", text: "你是助手" }], createdAt: now },
    {
      id: "u1",
      role: "user",
      content: [{ type: "text", text: "北京天气？" }],
      createdAt: now,
    },
    {
      id: "a1",
      role: "assistant",
      content: [
        { type: "think", think: "思考中" },
        { type: "text", text: "我来查" },
      ],
      toolCalls: [
        { toolCallId: "call_1", name: "get_weather", arguments: { location: "北京" } },
      ],
      createdAt: now,
    },
    {
      id: "t1",
      role: "tool",
      content: [{ type: "text", text: "20 度" }],
      toolCallId: "call_1",
      createdAt: now,
    },
  ];
}

const tools = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "查询天气",
      parameters: { type: "object", properties: { location: { type: "string" } }, required: ["location"] },
    },
  },
];

const servers: MockServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

describe("OpenAIResponsesProvider（mock server）", () => {
  it("请求体结构正确：input items + tools；流式解析 text/tool.call/usage", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        sse(`
{"type":"response.created","response":{"id":"r1","status":"in_progress"}}
{"type":"response.output_item.added","item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"get_weather"}}
{"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\\"loc"}
{"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"ation\\":\\"NYC\\"}"}
{"type":"response.output_item.done","item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"get_weather","arguments":"{\\"location\\":\\"NYC\\"}"}}
{"type":"response.output_text.delta","delta":"Hi "}
{"type":"response.output_text.delta","delta":"there"}
{"type":"response.reasoning_text.delta","delta":"想一下"}
{"type":"response.completed","response":{"id":"r1","status":"completed","usage":{"input_tokens":12,"output_tokens":7,"total_tokens":19}}}
`),
      );
    });
    servers.push(server);

    const provider = new OpenAIResponsesProvider("sk-test", server.url);
    const { events, error } = await collect(provider, {
      model: "deepseek-v4-flash",
      messages: baseMessages(),
      tools,
    });

    expect(error).toBeUndefined();
    expect(events.map((e) => e.type)).toEqual([
      "tool.call",
      "text.delta",
      "text.delta",
      "thinking.delta",
      "step.end",
    ]);
    const toolCall = events.find((e) => e.type === "tool.call");
    expect(toolCall).toMatchObject({
      type: "tool.call",
      toolCallId: "call_1",
      name: "get_weather",
      arguments: { location: "NYC" },
    });
    expect(events.at(-1)).toEqual({
      type: "step.end",
      usage: { promptTokens: 12, completionTokens: 7 },
    });

    expect(server.requests).toHaveLength(1);
    const req = server.requests[0];
    expect(req.url).toBe("/responses");
    expect(req.headers.authorization).toBe("Bearer sk-test");
    const body = req.body as Record<string, unknown>;
    expect(body.model).toBe("deepseek-v4-flash");
    expect(body.stream).toBe(true);
    const input = body.input as Array<Record<string, unknown>>;
    expect(input[0]).toEqual({ role: "system", content: "你是助手" });
    expect(input[1]).toEqual({ role: "user", content: [{ type: "input_text", text: "北京天气？" }] });
    expect(input[2]).toEqual({ role: "assistant", content: [{ type: "output_text", text: "我来查" }] });
    expect(input[3]).toEqual({
      type: "reasoning",
      content: [{ type: "reasoning_text", text: "思考中" }],
    });
    expect(input[4]).toEqual({
      type: "function_call",
      call_id: "call_1",
      name: "get_weather",
      arguments: JSON.stringify({ location: "北京" }),
    });
    expect(input[5]).toEqual({ type: "function_call_output", call_id: "call_1", output: "20 度" });
    expect(body.tools).toEqual([
      {
        type: "function",
        name: "get_weather",
        description: "查询天气",
        parameters: tools[0].function.parameters,
      },
    ]);
  });

  it("多轮回传：第二轮请求体含完整历史（含 thinking 块）且四类 item 形状正确（回归真机 400）", async () => {
    let calls = 0;
    const server = await startMockServer((_req, res) => {
      calls++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (calls === 1) {
        res.end(
          sse(`
{"type":"response.output_text.delta","delta":"我来查"}
{"type":"response.output_item.added","item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"get_weather"}}
{"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\\"loc"}
{"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"ation\\":\\"北京\\"}"}
{"type":"response.output_item.done","item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"get_weather","arguments":"{\\"location\\":\\"北京\\"}"}}
{"type":"response.completed","response":{"id":"r1","status":"completed","usage":{"input_tokens":5,"output_tokens":3}}}
`),
        );
        return;
      }
      res.end(
        sse(`
{"type":"response.output_text.delta","delta":"第二轮回答"}
{"type":"response.completed","response":{"id":"r2","status":"completed","usage":{"input_tokens":8,"output_tokens":4}}}
`),
      );
    });
    servers.push(server);

    const provider = new OpenAIResponsesProvider("sk-test", server.url);
    const now = new Date().toISOString();
    const r1 = await collect(provider, {
      model: "deepseek-v4-flash",
      messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "北京天气？" }], createdAt: now }],
      tools,
    });
    expect(r1.error).toBeUndefined();
    expect(r1.events.find((e) => e.type === "tool.call")).toMatchObject({
      type: "tool.call",
      toolCallId: "call_1",
      name: "get_weather",
      arguments: { location: "北京" },
    });

    // 第二轮回传完整历史：第一轮 user + assistant（思考/正文/工具调用）+ tool 结果 + 新一轮 user
    const r2 = await collect(provider, {
      model: "deepseek-v4-flash",
      messages: [
        { id: "u1", role: "user", content: [{ type: "text", text: "北京天气？" }], createdAt: now },
        {
          id: "a1",
          role: "assistant",
          content: [
            { type: "think", think: "思考一下" },
            { type: "text", text: "我来查" },
          ],
          toolCalls: [{ toolCallId: "call_1", name: "get_weather", arguments: { location: "北京" } }],
          createdAt: now,
        },
        { id: "t1", role: "tool", content: [{ type: "text", text: "20 度" }], toolCallId: "call_1", createdAt: now },
        { id: "u2", role: "user", content: [{ type: "text", text: "现在呢？" }], createdAt: now },
      ],
    });
    expect(r2.error).toBeUndefined();
    expect(r2.events.at(-1)).toMatchObject({ type: "step.end" });

    expect(server.requests).toHaveLength(2);
    const second = server.requests[1].body as Record<string, unknown>;
    expect(second.model).toBe("deepseek-v4-flash");
    const input = second.input as Array<Record<string, unknown>>;
    expect(input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "北京天气？" }] },
      { role: "assistant", content: [{ type: "output_text", text: "我来查" }] },
      { type: "reasoning", content: [{ type: "reasoning_text", text: "思考一下" }] },
      {
        type: "function_call",
        call_id: "call_1",
        name: "get_weather",
        arguments: JSON.stringify({ location: "北京" }),
      },
      { type: "function_call_output", call_id: "call_1", output: "20 度" },
      { role: "user", content: [{ type: "input_text", text: "现在呢？" }] },
    ]);
    // 回归真机 400：所有 message item 的 content 必须是数组，不能是裸字符串
    for (const item of input) {
      if ("content" in item) {
        expect(Array.isArray(item.content)).toBe(true);
      }
    }
  });

  it("response.incomplete → step.end finishReason=length", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        sse(`
{"type":"response.output_text.delta","delta":"截断"}
{"type":"response.incomplete","response":{"id":"r1","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"usage":{"input_tokens":3,"output_tokens":2}}}
`),
      );
    });
    servers.push(server);

    const provider = new OpenAIResponsesProvider("sk-test", server.url);
    const { events, error } = await collect(provider, {
      model: "deepseek-v4-flash",
      messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "hi" }], createdAt: new Date().toISOString() }],
    });

    expect(error).toBeUndefined();
    expect(events.at(-1)).toEqual({
      type: "step.end",
      finishReason: "length",
      usage: { promptTokens: 3, completionTokens: 2 },
    });
  });

  it("output_item.done 无 added（buffer 缺失）→ 用 done 事件本体兜底组装 tool.call，不静默丢弃", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        sse(`
{"type":"response.output_item.done","item":{"type":"function_call","id":"fc_9","call_id":"call_9","name":"get_weather","arguments":"{\\"location\\":\\"NYC\\"}"}}
{"type":"response.completed","response":{"id":"r1","status":"completed","usage":{"input_tokens":2,"output_tokens":1}}}
`),
      );
    });
    servers.push(server);

    const provider = new OpenAIResponsesProvider("sk-test", server.url);
    const { events, error } = await collect(provider, {
      model: "deepseek-v4-flash",
      messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "hi" }], createdAt: new Date().toISOString() }],
    });

    expect(error).toBeUndefined();
    expect(events[0]).toEqual({
      type: "tool.call",
      toolCallId: "call_9",
      name: "get_weather",
      arguments: { location: "NYC" },
    });
    expect(events.at(-1)).toMatchObject({ type: "step.end" });
  });
});

describe("AnthropicMessagesProvider（mock server）", () => {
  it("请求体结构正确：system 独立字段 + blocks + input_schema；流式解析 text/tool.call/usage", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        sse(`
{"type":"message_start","message":{"usage":{"input_tokens":8,"output_tokens":4}}}
{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}
{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}
{"type":"content_block_stop","index":0}
{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"get_weather","input":{}}}
{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"loc"}}
{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"ation\\":\\"NYC\\"}"}}
{"type":"content_block_stop","index":1}
{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"input_tokens":8,"output_tokens":6}}
{"type":"message_stop"}
`),
      );
    });
    servers.push(server);

    const provider = new AnthropicMessagesProvider("sk-test", server.url);
    const { events, error } = await collect(provider, {
      model: "deepseek-v4-flash",
      messages: baseMessages(),
      tools,
    });

    expect(error).toBeUndefined();
    expect(events.map((e) => e.type)).toEqual(["text.delta", "tool.call", "step.end"]);
    expect(events[0]).toEqual({ type: "text.delta", delta: "Hello" });
    expect(events[1]).toMatchObject({
      type: "tool.call",
      toolCallId: "toolu_1",
      name: "get_weather",
      arguments: { location: "NYC" },
    });
    expect(events.at(-1)).toEqual({
      type: "step.end",
      finishReason: "tool_calls",
      usage: { promptTokens: 8, completionTokens: 6 },
    });

    expect(server.requests).toHaveLength(1);
    const req = server.requests[0];
    expect(req.url).toBe("/anthropic/v1/messages");
    expect(req.headers["x-api-key"]).toBe("sk-test");
    expect(req.headers["anthropic-version"]).toBe("2023-06-01");
    const body = req.body as Record<string, unknown>;
    expect(body.model).toBe("deepseek-v4-flash");
    expect(body.max_tokens).toBe(4096);
    expect(body.system).toEqual([{ type: "text", text: "你是助手" }]);
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({ role: "user", content: [{ type: "text", text: "北京天气？" }] });
    expect(messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "思考中" },
        { type: "text", text: "我来查" },
        { type: "tool_use", id: "call_1", name: "get_weather", input: { location: "北京" } },
      ],
    });
    expect(messages[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call_1", content: "20 度" }],
    });
    expect(body.tools).toEqual([
      {
        name: "get_weather",
        description: "查询天气",
        input_schema: tools[0].function.parameters,
      },
    ]);
  });

  it("端点归一：baseUrl 以 /anthropic 结尾时不重复拼接", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sse(`{"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":1}}}`) +
        sse(`{"type":"message_stop"}`));
    });
    servers.push(server);

    const provider = new AnthropicMessagesProvider("sk-test", `${server.url}/anthropic`);
    const { error } = await collect(provider, {
      model: "m",
      messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "hi" }], createdAt: new Date().toISOString() }],
    });
    expect(error).toBeUndefined();
    expect(server.requests[0].url).toBe("/anthropic/v1/messages");
  });

  it("F8：原生 Anthropic 端点形态——message_delta 仅 output_tokens 即更新 usage（合并语义）", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        sse(`
{"type":"message_start","message":{"usage":{"input_tokens":8,"output_tokens":1}}}
{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}
{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}
{"type":"content_block_stop","index":0}
{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":6}}
{"type":"message_stop"}
`),
      );
    });
    servers.push(server);

    const provider = new AnthropicMessagesProvider("sk-test", server.url);
    const { events, error } = await collect(provider, {
      model: "claude-3-5",
      messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "hi" }], createdAt: new Date().toISOString() }],
    });

    expect(error).toBeUndefined();
    // output 覆盖为 message_delta 权威值 6；input 保留 message_start 的 8
    // （修复前守卫要求双 number，completionTokens 会停在 message_start 初值 1）
    expect(events.at(-1)).toEqual({
      type: "step.end",
      finishReason: "stop",
      usage: { promptTokens: 8, completionTokens: 6 },
    });
  });

  it("F8：input 无来源（message_start 缺 usage）时不虚构 promptTokens——step.end 不带 usage", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        sse(`
{"type":"message_start","message":{}}
{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}
{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}
{"type":"content_block_stop","index":0}
{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":6}}
{"type":"message_stop"}
`),
      );
    });
    servers.push(server);

    const provider = new AnthropicMessagesProvider("sk-test", server.url);
    const { events, error } = await collect(provider, {
      model: "claude-3-5",
      messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "hi" }], createdAt: new Date().toISOString() }],
    });

    expect(error).toBeUndefined();
    expect(events.at(-1)).toEqual({ type: "step.end", finishReason: "stop" });
    expect(events.at(-1)).not.toHaveProperty("usage");
  });

  it("孤立 content_block_stop（缺 start，协议违约）→ 丢弃不虚构 tool.call，流正常收尾", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        sse(`
{"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":1}}}
{"type":"content_block_stop","index":0}
{"type":"message_stop"}
`),
      );
    });
    servers.push(server);

    const provider = new AnthropicMessagesProvider("sk-test", server.url);
    const { events, error } = await collect(provider, {
      model: "claude-3-5",
      messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "hi" }], createdAt: new Date().toISOString() }],
    });

    expect(error).toBeUndefined();
    expect(events.some((e) => e.type === "tool.call")).toBe(false);
    expect(events.at(-1)).toEqual({
      type: "step.end",
      usage: { promptTokens: 1, completionTokens: 1 },
    });
  });
});

describe("OpenAICompatibleChatProvider（mock server，纯搬家回归）", () => {
  it("请求体 messages/tools 结构 + 流式 text/tool.call/usage 不变", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        sse(`
{"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}
{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_weather","arguments":"{\\"loc"}}]},"finish_reason":null}]}
{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ation\\":\\"NYC\\"}"}}]},"finish_reason":null}]}
{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}
{"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}
`),
      );
    });
    servers.push(server);

    const provider = new OpenAICompatibleChatProvider("sk-test", `${server.url}/v1`);
    const { events, error } = await collect(provider, {
      model: "deepseek-chat",
      messages: baseMessages(),
      tools,
    });

    expect(error).toBeUndefined();
    expect(events.map((e) => e.type)).toEqual(["text.delta", "tool.call", "step.end"]);
    expect(events[1]).toMatchObject({
      type: "tool.call",
      toolCallId: "call_1",
      name: "get_weather",
      arguments: { location: "NYC" },
    });
    expect(events.at(-1)).toEqual({
      type: "step.end",
      finishReason: "tool_calls",
      usage: { promptTokens: 5, completionTokens: 3 },
    });

    expect(server.requests).toHaveLength(1);
    const req = server.requests[0];
    expect(req.url).toBe("/v1/chat/completions");
    expect(req.headers.authorization).toBe("Bearer sk-test");
    const body = req.body as Record<string, unknown>;
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toMatchObject({ role: "system", content: "你是助手" });
    expect(messages[1]).toMatchObject({ role: "user", content: "北京天气？" });
    expect(messages[2]).toMatchObject({
      role: "assistant",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "get_weather", arguments: JSON.stringify({ location: "北京" }) },
        },
      ],
    });
    expect(messages[3]).toMatchObject({ role: "tool", content: "20 度", tool_call_id: "call_1" });
    expect(body.tools).toEqual(tools);
  });
});

describe("createProtocolProvider（apiMode 分支）", () => {
  it("缺省 → chat_completions；三值显式 → 对应适配器；非法值回退 chat_completions", () => {
    const base = { apiKey: "k", baseUrl: "https://example.com" };
    expect(createProtocolProvider(undefined, base)).toBeInstanceOf(OpenAICompatibleChatProvider);
    expect(createProtocolProvider("chat_completions", base)).toBeInstanceOf(OpenAICompatibleChatProvider);
    expect(createProtocolProvider("responses", base)).toBeInstanceOf(OpenAIResponsesProvider);
    expect(createProtocolProvider("anthropic", base)).toBeInstanceOf(AnthropicMessagesProvider);
    expect(createProtocolProvider("weird", base)).toBeInstanceOf(OpenAICompatibleChatProvider);
  });
});

describe("resilient 对协议适配器一视同仁", () => {
  it("responses 适配器 429（首事件前）→ 退避重试后成功", async () => {
    let calls = 0;
    const server = await startMockServer((_req, res) => {
      calls++;
      if (calls === 1) {
        res.writeHead(429, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "rate limited" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        sse(`
{"type":"response.output_text.delta","delta":"ok"}
{"type":"response.completed","response":{"id":"r1","status":"completed","usage":{"input_tokens":1,"output_tokens":1}}}
`),
      );
    });
    servers.push(server);

    const provider = new OpenAIResponsesProvider("k", server.url);
    const resilient = new ResilientLLMProvider(provider, { maxRetries: 2, sleep: async () => {} });
    const { events, error } = await collect(resilient, {
      model: "deepseek-v4-flash",
      messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "hi" }], createdAt: new Date().toISOString() }],
    });

    expect(error).toBeUndefined();
    expect(calls).toBe(2);
    expect(events).toMatchObject([
      { type: "text.delta", delta: "ok" },
      { type: "step.end", usage: { promptTokens: 1, completionTokens: 1 } },
    ]);
  });

  it("anthropic 适配器 401（首事件前）→ 不可重试，立即失败并抛 ProviderError", async () => {
    let calls = 0;
    const server = await startMockServer((_req, res) => {
      calls++;
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "authentication_error", message: "bad key" } }));
    });
    servers.push(server);

    const provider = new AnthropicMessagesProvider("k", server.url);
    const resilient = new ResilientLLMProvider(provider, { maxRetries: 2, sleep: async () => {} });
    const { events, error } = await collect(resilient, {
      model: "m",
      messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "hi" }], createdAt: new Date().toISOString() }],
    });

    expect(calls).toBe(1);
    expect(events.at(-1)?.type).toBe("step.end");
    expect(error).toBeInstanceOf(ProviderError);
  });
});

describe("shared 错误分类（cause 链，review P1）", () => {
  it("fetch 包装的网络错误：真实码在 err.cause.code → 可重试", () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), {
      code: "ECONNREFUSED",
    });
    const err = new TypeError("fetch failed", { cause });
    expect(toProviderError("t", err).retryable).toBe(true);
  });

  it("undici UND_ERR_* 前缀错误 → 可重试", () => {
    const cause = Object.assign(new Error("socket error"), { code: "UND_ERR_SOCKET" });
    expect(toProviderError("t", new TypeError("fetch failed", { cause })).retryable).toBe(true);
    const timeout = Object.assign(new Error("connect timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" });
    expect(toProviderError("t", new TypeError("fetch failed", { cause: timeout })).retryable).toBe(true);
  });

  it("AbortSignal.timeout 的 TimeoutError → 可重试", () => {
    const err = new Error("The operation was aborted due to timeout");
    err.name = "TimeoutError";
    expect(toProviderError("t", err).retryable).toBe(true);
  });

  it("多层嵌套 cause 链 → 可重试；AggregateError.errors 递归 → 可重试", () => {
    const inner = Object.assign(new Error("reset"), { code: "ECONNRESET" });
    const mid = new Error("boom", { cause: inner });
    expect(toProviderError("t", mid).retryable).toBe(true);

    const agg = new AggregateError([Object.assign(new Error("x"), { code: "EPIPE" })]);
    expect(toProviderError("t", agg).retryable).toBe(true);
  });

  it("顶层 code 回归：ECONNRESET 仍可重试；普通错误仍不可重试", () => {
    const top = Object.assign(new Error("reset"), { code: "ECONNRESET" });
    expect(toProviderError("t", top).retryable).toBe(true);
    expect(toProviderError("t", new Error("boom")).retryable).toBe(false);
    expect(toProviderError("t", "string error").retryable).toBe(false);
  });
});

describe("A2 隐私截断", () => {
  it("responses：无效 SSE JSON 帧错误消息截 500 字符，不落超长 raw", async () => {
    const garbage = "x".repeat(700);
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${garbage}\n\n`);
    });
    servers.push(server);

    const { error } = await collect(new OpenAIResponsesProvider("k", server.url), {
      model: "deepseek-v4-flash",
      messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "hi" }], createdAt: new Date().toISOString() }],
    });
    expect(error).toBeInstanceOf(ProviderError);
    const message = String(error);
    expect(message).toContain("无效的 SSE JSON 帧");
    expect(message).toContain("截断");
    expect(message.length).toBeLessThan(600);
    expect(message).not.toContain(garbage);
  });

  it("anthropic：无效 SSE JSON 帧错误消息截 500 字符，不落超长 raw", async () => {
    const garbage = "y".repeat(700);
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${garbage}\n\n`);
    });
    servers.push(server);

    const { error } = await collect(new AnthropicMessagesProvider("k", server.url), {
      model: "m",
      messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "hi" }], createdAt: new Date().toISOString() }],
    });
    expect(error).toBeInstanceOf(ProviderError);
    const message = String(error);
    expect(message).toContain("无效的 SSE JSON 帧");
    expect(message).toContain("截断");
    expect(message.length).toBeLessThan(600);
    expect(message).not.toContain(garbage);
  });

  it("parseToolArgs 解析失败 warn 的 raw 截 500 字符", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(parseToolArgs("t", "x".repeat(700))).toEqual({});
      expect(warn).toHaveBeenCalledOnce();
      const fields = warn.mock.calls[0]![0] as { raw?: string };
      expect(fields.raw!.length).toBeLessThan(600);
      expect(fields.raw).toContain("截断");
      expect(fields.raw).not.toContain("x".repeat(600));
    } finally {
      warn.mockRestore();
    }
  });

  it("F3：chat_completions 工具参数解析失败 warn 的 raw 截 500 字符", async () => {
    const garbage = "x".repeat(700);
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        sse(
          `{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"t","arguments":"${garbage}"}}]},"finish_reason":null}]}\n` +
            `{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}`,
        ),
      );
    });
    servers.push(server);

    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const provider = new OpenAICompatibleChatProvider("k", `${server.url}/v1`);
      const { events, error } = await collect(provider, {
        model: "m",
        messages: baseMessages(),
        tools,
      });
      expect(error).toBeUndefined();
      // 非法 JSON 参数 → 解析失败降级为 {}
      expect(events.find((e) => e.type === "tool.call")).toMatchObject({
        type: "tool.call",
        name: "t",
        arguments: {},
      });
      expect(warn).toHaveBeenCalledOnce();
      const fields = warn.mock.calls[0]![0] as { raw?: string };
      expect(fields.raw!.length).toBeLessThan(600);
      expect(fields.raw).toContain("截断");
      expect(fields.raw).not.toContain("x".repeat(600));
    } finally {
      warn.mockRestore();
    }
  });
});

describe("A7 重试分类合一", () => {
  it("统一入口 isRetryableError 保留强分类：cause 链/UND_ERR_/AggregateError", () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), {
      code: "ECONNREFUSED",
    });
    expect(isRetryableError(new TypeError("fetch failed", { cause }))).toBe(true);
    expect(isRetryableError(Object.assign(new Error("socket"), { code: "UND_ERR_SOCKET" }))).toBe(true);
    expect(
      isRetryableError(
        new AggregateError([Object.assign(new Error("x"), { code: "EPIPE" })]),
      ),
    ).toBe(true);
    expect(isRetryableError(new Error("boom"))).toBe(false);
  });

  it("openai-compatible 429（首事件前）→ 可重试并退避重试成功（与协议族同源分类）", async () => {
    let calls = 0;
    const server = await startMockServer((_req, res) => {
      calls++;
      if (calls === 1) {
        res.writeHead(429, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "rate limited" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        sse(`{"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}`) +
          sse(`{"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}`),
      );
    });
    servers.push(server);

    const provider = new OpenAICompatibleChatProvider("k", `${server.url}/v1`);
    const resilient = new ResilientLLMProvider(provider, { maxRetries: 2, sleep: async () => {} });
    const { events, error } = await collect(resilient, {
      model: "deepseek-chat",
      messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "hi" }], createdAt: new Date().toISOString() }],
    });
    expect(error).toBeUndefined();
    expect(calls).toBe(2);
    expect(events.at(-1)).toMatchObject({ type: "step.end" });
  });

  it("三族对同一网络错误给出一致 retryable 结论", async () => {
    const server = await startMockServer((_req, res) => {
      // 握手后立即断连（未写任何响应头）：三族走同一条网络错误分类
      res.socket?.destroy();
    });
    servers.push(server);
    const params: LLMChatParams = {
      model: "m",
      messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "hi" }], createdAt: new Date().toISOString() }],
    };
    const providers = [
      new OpenAICompatibleChatProvider("k", `${server.url}/v1`),
      new OpenAIResponsesProvider("k", server.url),
      new AnthropicMessagesProvider("k", server.url),
    ];
    for (const provider of providers) {
      const { error } = await collect(provider, params);
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).retryable).toBe(true);
    }
  });
});

describe("SSE 韧性（review P2-1 补充测试）", () => {
  it("中途断流：已产出部分文本后抛 ProviderError，不吞事件", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"type":"response.output_text.delta","delta":"part"}\n\n', () => {
        res.socket?.destroy();
      });
    });
    servers.push(server);

    const provider = new OpenAIResponsesProvider("k", server.url);
    const { events, error } = await collect(provider, {
      model: "deepseek-v4-flash",
      messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "hi" }], createdAt: new Date().toISOString() }],
    });

    expect(events.some((e) => e.type === "text.delta" && e.delta === "part")).toBe(true);
    expect(error).toBeInstanceOf(ProviderError);
  });

  it("缺终态事件（responses）：文本已产出但流干净结束 → 显式报错", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('data: {"type":"response.output_text.delta","delta":"Hi"}\n\n');
    });
    servers.push(server);

    const provider = new OpenAIResponsesProvider("k", server.url);
    const { events, error } = await collect(provider, {
      model: "deepseek-v4-flash",
      messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "hi" }], createdAt: new Date().toISOString() }],
    });

    expect(events).toMatchObject([{ type: "text.delta", delta: "Hi" }]);
    expect(error).toBeInstanceOf(ProviderError);
    expect(String(error)).toContain("终态事件");
  });

  it("缺 message_stop（anthropic）：容错收尾 step.end，保留 usage", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        sse(`{"type":"message_start","message":{"usage":{"input_tokens":4,"output_tokens":2}}}`) +
          sse(`{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`) +
          sse(`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}`),
      );
    });
    servers.push(server);

    const provider = new AnthropicMessagesProvider("k", server.url);
    const { events, error } = await collect(provider, {
      model: "m",
      messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "hi" }], createdAt: new Date().toISOString() }],
    });

    expect(error).toBeUndefined();
    expect(events.at(-1)).toEqual({
      type: "step.end",
      usage: { promptTokens: 4, completionTokens: 2 },
    });
  });

  it("半包粘包：JSON 行跨多个 chunk 分片仍正确解析", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const parts = [
        'data: {"type":"response.output_text.delta","del',
        'ta":"Hel',
        'lo!"}\n\n',
        'data: {"type":"response.completed","response":{"id":"r1",',
        '"status":"completed","usage":{"input_tokens":3,"output_tokens":2}}}\n\n',
      ];
      for (const part of parts) res.write(part);
      res.end();
    });
    servers.push(server);

    const provider = new OpenAIResponsesProvider("k", server.url);
    const { events, error } = await collect(provider, {
      model: "deepseek-v4-flash",
      messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "hi" }], createdAt: new Date().toISOString() }],
    });

    expect(error).toBeUndefined();
    expect(events).toEqual([
      { type: "text.delta", delta: "Hello!" },
      { type: "step.end", usage: { promptTokens: 3, completionTokens: 2 } },
    ]);
  });

  it("并发多 tool_call：按 item_id 归并不串台", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        sse(`
{"type":"response.output_item.added","item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"get_weather"}}
{"type":"response.output_item.added","item":{"type":"function_call","id":"fc_2","call_id":"call_2","name":"get_time"}}
{"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\\"loc"}
{"type":"response.function_call_arguments.delta","item_id":"fc_2","delta":"{\\"tz"}
{"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"ation\\":\\"NYC\\"}"}
{"type":"response.function_call_arguments.delta","item_id":"fc_2","delta":"\\":\\"UTC\\"}"}
{"type":"response.output_item.done","item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"get_weather","arguments":"{\\"location\\":\\"NYC\\"}"}}
{"type":"response.output_item.done","item":{"type":"function_call","id":"fc_2","call_id":"call_2","name":"get_time","arguments":"{\\"tz\\":\\"UTC\\"}"}}
{"type":"response.completed","response":{"id":"r1","status":"completed","usage":{"input_tokens":5,"output_tokens":3}}}
`),
      );
    });
    servers.push(server);

    const provider = new OpenAIResponsesProvider("k", server.url);
    const { events, error } = await collect(provider, {
      model: "deepseek-v4-flash",
      messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "hi" }], createdAt: new Date().toISOString() }],
    });

    expect(error).toBeUndefined();
    const toolCalls = events.filter((e) => e.type === "tool.call");
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]).toEqual({
      type: "tool.call",
      toolCallId: "call_1",
      name: "get_weather",
      arguments: { location: "NYC" },
    });
    expect(toolCalls[1]).toEqual({
      type: "tool.call",
      toolCallId: "call_2",
      name: "get_time",
      arguments: { tz: "UTC" },
    });
  });

  it("空流：responses 报缺终态；anthropic 空流判死（P1-2，可重试分类）", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end();
    });
    servers.push(server);

    const params: LLMChatParams = {
      model: "deepseek-v4-flash",
      messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "hi" }], createdAt: new Date().toISOString() }],
    };
    const r1 = await collect(new OpenAIResponsesProvider("k", server.url), params);
    expect(r1.events).toHaveLength(0);
    expect(r1.error).toBeInstanceOf(ProviderError);
    expect(String(r1.error)).toContain("终态事件");

    const a1 = await collect(new AnthropicMessagesProvider("k", server.url), params);
    expect(a1.events).toHaveLength(0);
    expect(a1.error).toBeInstanceOf(ProviderError);
    expect(String(a1.error)).toContain("空流");
    expect((a1.error as ProviderError).retryable).toBe(true);
  });

  it("P1-2：anthropic 空流 → resilient 重试成功（无空 assistant 落盘，下轮不 400）", async () => {
    let calls = 0;
    const server = await startMockServer((_req, res) => {
      calls++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (calls === 1) {
        // 第一次：空流（无任何事件即结束）
        res.end();
        return;
      }
      res.end(
        sse(`{"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":1}}}`) +
          sse(`{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`) +
          sse(`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}`) +
          sse(`{"type":"message_stop"}`),
      );
    });
    servers.push(server);

    const provider = new AnthropicMessagesProvider("k", server.url);
    const resilient = new ResilientLLMProvider(provider, { maxRetries: 1, sleep: async () => {} });
    const { events, error } = await collect(resilient, {
      model: "deepseek-v4-flash",
      messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "hi" }], createdAt: new Date().toISOString() }],
    });

    expect(error).toBeUndefined();
    expect(calls).toBe(2);
    // 空流没有产出任何事件；重试成功路径只含真实内容，不携带空 assistant 形状
    expect(events).toMatchObject([{ type: "text.delta", delta: "ok" }, { type: "step.end" }]);
  });
});

describe("P1-3 usage 非有限值防护", () => {
  it("openai-compatible：usage 缺字段（undefined）→ step.end 不带 usage，不产 NaN", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        sse(`{"choices":[{"delta":{"content":"Hi"},"finish_reason":"stop"}]}`) +
          sse(`{"choices":[],"usage":{"total_tokens":8}}`),
      );
    });
    servers.push(server);

    const provider = new OpenAICompatibleChatProvider("k", `${server.url}/v1`);
    const { events, error } = await collect(provider, {
      model: "deepseek-chat",
      messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "hi" }], createdAt: new Date().toISOString() }],
    });

    expect(error).toBeUndefined();
    expect(events.at(-1)).toEqual({ type: "step.end", finishReason: "stop" });
    expect(events.at(-1)).not.toHaveProperty("usage");
  });

  it("openai-compatible：usage 非有限值 → 同样丢弃，不产 NaN", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        sse(`{"choices":[{"delta":{"content":"Hi"},"finish_reason":"stop"}]}`) +
          sse(`{"choices":[],"usage":{"prompt_tokens":null,"completion_tokens":null}}`),
      );
    });
    servers.push(server);

    const provider = new OpenAICompatibleChatProvider("k", `${server.url}/v1`);
    const { events, error } = await collect(provider, {
      model: "deepseek-chat",
      messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "hi" }], createdAt: new Date().toISOString() }],
    });

    expect(error).toBeUndefined();
    expect(events.at(-1)).toEqual({ type: "step.end", finishReason: "stop" });
    expect(events.at(-1)).not.toHaveProperty("usage");
  });
});

describe("连接释放（review P2-1）", () => {
  it("终态事件后提前 return：取消未读完的响应体，服务端观察到连接关闭", async () => {
    let response: http.ServerResponse | undefined;
    const server = await startMockServer((_req, res) => {
      response = res;
      res.writeHead(200, { "content-type": "text/event-stream" });
      // 只发终态事件，不 end：客户端应在 step.end 后主动 cancel 并断开
      res.write('data: {"type":"response.completed","response":{"id":"r1","status":"completed","usage":{"input_tokens":1,"output_tokens":1}}}\n\n');
    });
    servers.push(server);

    const provider = new OpenAIResponsesProvider("k", server.url);
    const { events, error } = await collect(provider, {
      model: "deepseek-v4-flash",
      messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "hi" }], createdAt: new Date().toISOString() }],
    });
    expect(error).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: "step.end" });
    expect(response).toBeDefined();
    expect(await waitClose(response!)).toBe(true);
  });

  it("requestTimeout 超时中断：抛不可重试 ProviderError，连接被释放", async () => {
    let response: http.ServerResponse | undefined;
    const server = await startMockServer((_req, res) => {
      response = res;
      res.writeHead(200, { "content-type": "text/event-stream" });
      // 发一个事件后挂起，让空闲超时在读取中途触发
      res.write('data: {"type":"response.output_text.delta","delta":"hi"}\n\n');
    });
    servers.push(server);

    const provider = new OpenAIResponsesProvider("k", server.url, { requestTimeout: 60 });
    const { events, error } = await collect(provider, {
      model: "deepseek-v4-flash",
      messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "hi" }], createdAt: new Date().toISOString() }],
    });

    expect(events.some((e) => e.type === "text.delta")).toBe(true);
    expect(error).toBeInstanceOf(ProviderError);
    // 2026-11-01 P1：空闲超时改判**不可重试**。本例已产出 text.delta，重试会让
    // 用户看到重复输出；总时长时代判可重试，是因为 AbortSignal.timeout 的
    // TimeoutError 被统一归入网络超时（宽松），并未区分「是否已产出内容」。
    expect((error as ProviderError).retryable).toBe(false);
    expect(response).toBeDefined();
    expect(await waitClose(response!)).toBe(true);
  });
});

describe("流空闲超时（2026-11-01 P1）", () => {
  it("持续有数据的长回答不被总时长砍断（空闲语义 ≠ 总时长语义）", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      let n = 0;
      const timer = setInterval(() => {
        n += 1;
        res.write(`data: {"type":"response.output_text.delta","delta":"chunk${n}"}\n\n`);
        if (n >= 6) {
          clearInterval(timer);
          res.write(
            'data: {"type":"response.completed","response":{"id":"r1","status":"completed","usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
          );
          res.end();
        }
      }, 50);
      res.on("close", () => clearInterval(timer));
    });
    servers.push(server);

    // 总时长约 300ms（6×50ms）远超 120ms 阈值，但每次间隔 50ms < 120ms
    const provider = new OpenAIResponsesProvider("k", server.url, { requestTimeout: 120 });
    const { events, error } = await collect(provider, {
      model: "deepseek-v4-flash",
      messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "hi" }], createdAt: new Date().toISOString() }],
    });

    expect(error).toBeUndefined();
    expect(events.filter((e) => e.type === "text.delta")).toHaveLength(6);
    expect(events.at(-1)).toMatchObject({ type: "step.end" });
  });

  it("空闲超时错误名为 StreamIdleTimeoutError，且不判可重试", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      // 只发响应头，一个数据块都不发
      res.write(": keep-alive\n\n");
    });
    servers.push(server);

    const provider = new OpenAIResponsesProvider("k", server.url, { requestTimeout: 80 });
    const { error } = await collect(provider, {
      model: "deepseek-v4-flash",
      messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "hi" }], createdAt: new Date().toISOString() }],
    });

    expect(error).toBeInstanceOf(ProviderError);
    const cause = (error as ProviderError).cause as Error;
    expect(cause.name).toBe("StreamIdleTimeoutError");
    expect((error as ProviderError).retryable).toBe(false);
  });

  it("resolveIdleTimeoutMs：显式配置优先 / ≤0 关闭 / 缺省兜底", () => {
    expect(resolveIdleTimeoutMs(5_000)).toBe(5_000);
    expect(resolveIdleTimeoutMs(0)).toBeUndefined();
    expect(resolveIdleTimeoutMs(-1)).toBeUndefined();
    expect(resolveIdleTimeoutMs(Number.NaN)).toBeUndefined();

    const saved = process.env.CLOUDMIND_STREAM_IDLE_TIMEOUT_MS;
    try {
      delete process.env.CLOUDMIND_STREAM_IDLE_TIMEOUT_MS;
      expect(resolveIdleTimeoutMs(undefined)).toBe(DEFAULT_STREAM_IDLE_TIMEOUT_MS);

      process.env.CLOUDMIND_STREAM_IDLE_TIMEOUT_MS = "4500";
      expect(resolveIdleTimeoutMs(undefined)).toBe(4_500);

      // 显式配置压过环境变量
      expect(resolveIdleTimeoutMs(9_000)).toBe(9_000);

      process.env.CLOUDMIND_STREAM_IDLE_TIMEOUT_MS = "0";
      expect(resolveIdleTimeoutMs(undefined)).toBeUndefined();

      // 非法值回落缺省（不静默关闭）
      process.env.CLOUDMIND_STREAM_IDLE_TIMEOUT_MS = "abc";
      expect(resolveIdleTimeoutMs(undefined)).toBe(DEFAULT_STREAM_IDLE_TIMEOUT_MS);
    } finally {
      if (saved === undefined) delete process.env.CLOUDMIND_STREAM_IDLE_TIMEOUT_MS;
      else process.env.CLOUDMIND_STREAM_IDLE_TIMEOUT_MS = saved;
    }
  });
});

describe("外部取消（2026-11-01 P2）", () => {
  it("signal abort 立即中断在途流，不等空闲超时", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"type":"response.output_text.delta","delta":"hi"}\n\n');
      // 之后挂起：只有外部 signal 能把它掐断
    });
    servers.push(server);

    const controller = new AbortController();
    // 空闲超时设 60s——若中断依赖它，本用例会跑满一分钟
    const provider = new OpenAIResponsesProvider("k", server.url, { requestTimeout: 60_000 });
    setTimeout(() => controller.abort({ reason: "watchdog" }), 50);

    const startedAt = Date.now();
    const { error } = await collect(provider, {
      model: "deepseek-v4-flash",
      messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "hi" }], createdAt: new Date().toISOString() }],
      signal: controller.signal,
    });
    const elapsed = Date.now() - startedAt;

    expect(error).toBeInstanceOf(ProviderError);
    expect(isTurnAbortedError(error)).toBe(true);
    // 外部取消不可重试，也不能被 resilient 当成可降级故障
    expect((error as ProviderError).retryable).toBe(false);
    expect(elapsed).toBeLessThan(5_000);
  });

  it("signal 已 abort 时上游直接失败，不发请求", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end();
    });
    servers.push(server);

    const controller = new AbortController();
    controller.abort();
    const provider = new OpenAIResponsesProvider("k", server.url);

    const { error } = await collect(provider, {
      model: "deepseek-v4-flash",
      messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "hi" }], createdAt: new Date().toISOString() }],
      signal: controller.signal,
    });

    expect(isTurnAbortedError(error)).toBe(true);
    expect((error as ProviderError).retryable).toBe(false);
  });
});
