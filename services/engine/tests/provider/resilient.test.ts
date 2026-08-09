import { describe, it, expect } from "vitest";
import OpenAI from "openai";
import { ResilientLLMProvider } from "../../src/provider/resilient.js";
import { isRetryableError } from "../../src/provider/classify.js";
import { ProviderError } from "../../src/provider/errors.js";
import { OpenAIProvider } from "../../src/provider/llm.js";
import { withLLMCallRecording } from "../../src/provider/record-calls.js";
import type { LLMProvider, LLMEvent, LLMChatParams } from "../../src/provider/types.js";
import type { LLMCallRecord } from "../../src/memory/repositories/types.js";

const noSleep = async () => {};
const okEvents: LLMEvent[] = [
  { type: "text.delta", delta: "ok" },
  { type: "step.end" },
];

const rateLimited = () => new OpenAI.APIError(429, undefined, "rate limited", undefined);
const serverError = () => new OpenAI.APIError(500, undefined, "internal", undefined);
const unauthorized = () => new OpenAI.APIError(401, undefined, "bad key", undefined);

/** 依次按 behaviors 行事（失败抛错 / 成功流式产出）；超出长度复用最后一项 */
function scriptedProvider(name: string, behaviors: Array<Error | LLMEvent[]>) {
  let calls = 0;
  const provider: LLMProvider = {
    name,
    supportsModel: () => true,
    async *chat(_params: LLMChatParams) {
      void _params;
      const behavior = behaviors[Math.min(calls, behaviors.length - 1)];
      calls++;
      if (behavior instanceof Error) throw behavior;
      for (const e of behavior) yield e;
    },
  };
  return { provider, calls: () => calls };
}

/** 先流式产出事件再失败（首事件后失败场景） */
function streamThenFailProvider(name: string, events: LLMEvent[], err: Error) {
  let calls = 0;
  const provider: LLMProvider = {
    name,
    supportsModel: () => true,
    async *chat() {
      calls++;
      for (const e of events) yield e;
      throw err;
    },
  };
  return { provider, calls: () => calls };
}

async function collect(provider: LLMProvider): Promise<{ events: LLMEvent[]; error?: unknown }> {
  const events: LLMEvent[] = [];
  try {
    for await (const e of provider.chat({ model: "m", messages: [] })) events.push(e);
    return { events };
  } catch (error) {
    return { events, error };
  }
}

describe("isRetryableError（错误分类）", () => {
  it("429 / 5xx / 网络错误 / 超时 = 可重试", () => {
    expect(isRetryableError(rateLimited())).toBe(true);
    expect(isRetryableError(serverError())).toBe(true);
    expect(isRetryableError(new OpenAI.APIError(503, undefined, "unavailable", undefined))).toBe(true);
    expect(isRetryableError(new OpenAI.APIConnectionError({ message: "reset" }))).toBe(true);
    expect(isRetryableError(new OpenAI.APIConnectionTimeoutError({ message: "timeout" }))).toBe(true);
    const errno = Object.assign(new Error("reset"), { code: "ECONNRESET" });
    expect(isRetryableError(errno)).toBe(true);
  });

  it("401 / 403 / 400 及其他 4xx = 立即失败；无法归类默认不可重试（fail-closed）", () => {
    expect(isRetryableError(unauthorized())).toBe(false);
    expect(isRetryableError(new OpenAI.APIError(403, undefined, "forbidden", undefined))).toBe(false);
    expect(isRetryableError(new OpenAI.APIError(400, undefined, "bad request", undefined))).toBe(false);
    expect(isRetryableError(new OpenAI.APIError(422, undefined, "unprocessable", undefined))).toBe(false);
    expect(isRetryableError(new Error("something"))).toBe(false);
    expect(isRetryableError("string error")).toBe(false);
  });

  it("ProviderError 携带抛出方的分类结论", () => {
    expect(isRetryableError(new ProviderError("openai", "x", { retryable: true }))).toBe(true);
    expect(isRetryableError(new ProviderError("openai", "x"))).toBe(false);
  });
});

describe("ResilientLLMProvider", () => {
  it("首事件前失败（429）→ 退避重试后成功", async () => {
    const { provider, calls } = scriptedProvider("p1", [rateLimited(), okEvents]);
    const resilient = new ResilientLLMProvider(provider, { maxRetries: 2, sleep: noSleep });

    const { events, error } = await collect(resilient);
    expect(error).toBeUndefined();
    expect(events).toEqual(okEvents);
    expect(calls()).toBe(2);
  });

  it("首事件后失败 → 不重试，部分输出保留，错误直接上抛", async () => {
    const partial: LLMEvent[] = [{ type: "text.delta", delta: "半截" }];
    const { provider, calls } = streamThenFailProvider("p1", partial, serverError());
    const resilient = new ResilientLLMProvider(provider, { maxRetries: 2, sleep: noSleep });

    const { events, error } = await collect(resilient);
    expect(events).toEqual(partial);
    expect(error).toBeDefined();
    expect(calls()).toBe(1);
  });

  it("429 重试到耗尽（maxRetries=2 → 共 3 次尝试）后走统一失败出口", async () => {
    const { provider, calls } = scriptedProvider("p1", [rateLimited()]);
    const resilient = new ResilientLLMProvider(provider, { maxRetries: 2, sleep: noSleep });

    const { events, error } = await collect(resilient);
    expect(calls()).toBe(3);
    expect(events.at(-2)?.type).toBe("text.delta");
    expect(events.at(-1)?.type).toBe("step.end");
    expect(error).toBeInstanceOf(ProviderError);
  });

  it("401 立即失败（不重试，仅 1 次尝试）", async () => {
    const { provider, calls } = scriptedProvider("p1", [unauthorized()]);
    const resilient = new ResilientLLMProvider(provider, { maxRetries: 2, sleep: noSleep });

    const { events, error } = await collect(resilient);
    expect(calls()).toBe(1);
    expect(events.at(-1)?.type).toBe("step.end");
    expect(error).toBeInstanceOf(ProviderError);
  });

  it("主失败 → 备用成功；每次底层尝试（主+备）独立落档", async () => {
    const records: LLMCallRecord[] = [];
    const sink = { append: async (r: LLMCallRecord) => { records.push(r); } };
    const record = (p: LLMProvider) => withLLMCallRecording(p, sink, "agent-t");

    const primary = scriptedProvider("primary", [serverError()]);
    const backup = scriptedProvider("backup", [okEvents]);
    const resilient = new ResilientLLMProvider(record(primary.provider), {
      maxRetries: 0,
      sleep: noSleep,
      fallbackProviderIds: ["backup-id"],
      fallbackFactory: async (id) => (id === "backup-id" ? record(backup.provider) : undefined),
    });

    const { events, error } = await collect(resilient);
    expect(error).toBeUndefined();
    expect(events).toEqual(okEvents);
    expect(primary.calls()).toBe(1);
    expect(backup.calls()).toBe(1);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ provider: "primary", status: "error" });
    expect(records[1]).toMatchObject({ provider: "backup", status: "ok" });
  });

  it("全链失败 → 统一错误文本 + step.end + ProviderError（消息含主→备尝试链）", async () => {
    const primary = scriptedProvider("primary", [serverError()]);
    const backup = scriptedProvider("backup", [rateLimited()]);
    const resilient = new ResilientLLMProvider(primary.provider, {
      maxRetries: 0,
      sleep: noSleep,
      fallbackProviderIds: ["backup-id"],
      fallbackFactory: async () => backup.provider,
    });

    const { events, error } = await collect(resilient);
    const text = events.find((e) => e.type === "text.delta");
    expect(text).toMatchObject({ type: "text.delta" });
    expect(events.at(-1)?.type).toBe("step.end");
    expect(error).toBeInstanceOf(ProviderError);
    const message = String(error);
    expect(message).toContain("primary");
    expect(message).toContain("backup");
  });

  it("S2：降级到不同协议备用后 protocol 跟随当前活跃 provider（预检口径跟着换）", async () => {
    const primary = scriptedProvider("primary", [serverError()]);
    const backup = scriptedProvider("backup", [okEvents]);
    const resilient = new ResilientLLMProvider(
      { ...primary.provider, protocol: "chat_completions" },
      {
        maxRetries: 0,
        sleep: noSleep,
        fallbackProviderIds: ["backup-id"],
        fallbackFactory: async () => ({ ...backup.provider, protocol: "anthropic" }),
      },
    );

    // 降级前：主 provider 的协议（chat_completions 预检剥 think）
    expect(resilient.protocol).toBe("chat_completions");

    const { events, error } = await collect(resilient);
    expect(error).toBeUndefined();
    expect(events).toEqual(okEvents);

    // 降级后：协议切到备用（anthropic 预检含 think），不再固定主协议
    expect(resilient.protocol).toBe("anthropic");
  });
});

describe("OpenAIProvider 配置透传", () => {
  it("requestTimeout 透传 SDK timeout；SDK 内置重试禁用（maxRetries=0）", () => {
    const provider = new OpenAIProvider("k", "http://localhost", { requestTimeout: 1234 });
    const client = (provider as unknown as { client: { timeout: number; maxRetries: number } }).client;
    expect(client.timeout).toBe(1234);
    expect(client.maxRetries).toBe(0);
  });

  it("未传 requestTimeout 时不覆盖 SDK 默认 timeout，maxRetries 仍为 0", () => {
    const provider = new OpenAIProvider("k", "http://localhost");
    const client = (provider as unknown as { client: { timeout: number; maxRetries: number } }).client;
    expect(client.maxRetries).toBe(0);
    expect(client.timeout).toBeGreaterThan(0);
  });
});
