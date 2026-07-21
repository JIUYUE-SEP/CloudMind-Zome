import { describe, it, expect } from "vitest";
import { get_encoding } from "@dqbd/tiktoken";
import type { ChatMessage } from "@mindcloud/shared";
import {
  ContextPipeline,
  type AssembleInput,
  type AssembleResult,
} from "../../src/context/pipeline.js";
import { createLayers, type ToolSchema } from "../../src/context/layers.js";
import { assembleMessages } from "../../src/context/assembler.js";
import { selectNextStep } from "../../src/context/downgrade.js";
import { getTokenCounter, type TokenCounter } from "../../src/context/token-counter.js";
import { MockLLMProvider } from "../../src/provider/llm.js";
import type { LLMChatParams, LLMEvent } from "../../src/provider/types.js";

/**
 * ContextPipeline Phase 1 mock 集成测试。
 * 背景：真实 LLM（DeepSeek）从 CN 网络调用超时，这里全程使用 MockLLMProvider，
 * 不发起任何外部请求；token 计数使用真实 tiktoken（cl100k_base），不用 FakeCounter，
 * 以验证管线在真实计数下的降级行为。
 */

/** 捕获参数的 MockLLMProvider：保留 mock 应答行为，同时记录收到的请求 */
class CapturingMockProvider extends MockLLMProvider {
  captured: LLMChatParams[] = [];
  override async *chat(params: LLMChatParams): AsyncIterable<LLMEvent> {
    this.captured.push(params);
    yield* super.chat(params);
  }
}

function userMsg(id: string, text: string): ChatMessage {
  return {
    id,
    role: "user",
    content: [{ type: "text", text }],
    createdAt: "2026-07-17T00:00:00Z",
  };
}

function history(n: number, text = "hello"): ChatMessage[] {
  return Array.from({ length: n }, (_, i) => userMsg(`h${i}`, `${text} ${i}`));
}

function longHistory(n: number): ChatMessage[] {
  // 每条十几到二十 token（真实 tiktoken 计数），30 条远超小预算
  return Array.from({ length: n }, (_, i) =>
    userMsg(`h${i}`, `message number ${i} with some extra text to consume tokens`),
  );
}

function bigTools(n: number): ToolSchema[] {
  return Array.from({ length: n }, (_, i) => ({
    type: "function",
    function: {
      name: `tool_${i}`,
      description: `工具 ${i} 的详细描述，用于占用 token 预算。`.repeat(20),
      parameters: { type: "object", properties: {} },
    },
  }));
}

function makeInput(overrides: Partial<AssembleInput> = {}): AssembleInput {
  return {
    agentId: "a1",
    history: [],
    mindContext: "",
    tools: [],
    sourceId: "s1",
    ...overrides,
  };
}

function textOf(m: ChatMessage): string {
  const part = m.content[0];
  return part.type === "text" ? part.text : part.think;
}

function totalTokens(counter: TokenCounter, result: AssembleResult): number {
  return counter.countMessages(result.messages) + counter.countTools(result.tools);
}

/** 端到端：assemble →（可能的降级）→ 结果直接发给 MockLLMProvider → 收应答 */
async function runEndToEnd(
  pipeline: ContextPipeline,
  input: AssembleInput,
): Promise<{ assembled: AssembleResult; events: LLMEvent[]; provider: CapturingMockProvider }> {
  const provider = new CapturingMockProvider();
  const assembled = await pipeline.assemble(input);
  const events: LLMEvent[] = [];
  for await (const e of provider.chat({ model: "mock", messages: assembled.messages, tools: assembled.tools })) {
    events.push(e);
  }
  return { assembled, events, provider };
}

function expectMockReply(events: LLMEvent[]): void {
  expect(events.map((e) => e.type)).toEqual(["text.delta", "step.end"]);
  expect((events[0] as { type: "text.delta"; delta: string }).delta).toBe("Hello from mock");
}

describe("端到端：assemble → MockLLMProvider（无外部 LLM 依赖）", () => {
  it("空历史 + 短消息：不降级，mock 正常应答", async () => {
    const tools = bigTools(1);
    const { assembled, events, provider } = await runEndToEnd(
      new ContextPipeline(), // 默认配置：80000 × 0.9 预算
      makeInput({ mindContext: "人格：你是小云。", tools }),
    );
    // 无历史可截：L1 system 一条，tools 原样
    expect(assembled.messages).toHaveLength(1);
    expect(assembled.messages[0].role).toBe("system");
    expect(textOf(assembled.messages[0])).toBe("人格：你是小云。");
    expect(assembled.tools).toEqual(tools);
    // provider 收到的就是 assemble 的返回（同引用），应答正常
    expect(provider.captured[0].messages).toBe(assembled.messages);
    expectMockReply(events);
  });

  it("长历史超预算：降级截断后的结果仍可直接发给 mock 并完成应答", async () => {
    const { assembled, events, provider } = await runEndToEnd(
      new ContextPipeline({ maxContextTokens: 200, reserveRatio: 0 }),
      makeInput({ history: longHistory(30) }),
    );
    const received = provider.captured[0].messages;
    expect(received.length).toBeLessThan(30);
    expect(received.at(-1)!.id).toBe("h29");
    expectMockReply(events);
    void assembled;
  });
});

describe("token 计数准确（tiktoken 真实计数）", () => {
  it("countText 与独立 cl100k_base 编码结果完全一致", () => {
    const enc = get_encoding("cl100k_base");
    try {
      const counter = getTokenCounter();
      const samples = ["", "hello", "人格文件：你是小云", "a".repeat(1000), "emoji 😀 test"];
      for (const s of samples) {
        expect(counter.countText(s)).toBe(s ? enc.encode(s).length : 0);
      }
    } finally {
      enc.free();
    }
  });

  it("countMessages = 每条 4 结构开销 + role + content + toolCalls", () => {
    const enc = get_encoding("cl100k_base");
    try {
      const counter = getTokenCounter();
      const m1 = userMsg("u1", "hello world");
      const m2: ChatMessage = {
        id: "a1",
        role: "assistant",
        content: [{ type: "text", text: "calling tool" }],
        toolCalls: [{ toolCallId: "tc1", name: "read_file", arguments: { path: "/a" } }],
        createdAt: "2026-07-17T00:00:00Z",
      };
      const expected =
        4 + enc.encode("user").length + enc.encode("hello world").length +
        4 + enc.encode("assistant").length + enc.encode("calling tool").length +
        enc.encode(JSON.stringify(m2.toolCalls)).length;
      expect(counter.countMessages([m1, m2])).toBe(expected);
    } finally {
      enc.free();
    }
  });

  it("降级后总量（messages + tools）不超过预算，按真实计数核验", async () => {
    const counter = getTokenCounter();
    const tools = bigTools(3);
    // 预算 = 工具占用 + 200，必然触发 L3 截断，且截到 keep-5 后足以放下
    const pipeline = new ContextPipeline({
      maxContextTokens: counter.countTools(tools) + 200,
      reserveRatio: 0,
    });
    const result = await pipeline.assemble(makeInput({ history: longHistory(30), tools }));
    expect(result.messages.filter((m) => m.role === "user").length).toBeLessThan(30);
    expect(totalTokens(counter, result)).toBeLessThanOrEqual(pipeline.budgetTokens);
  });
});

describe("长历史触发 L3 截断", () => {
  it("超阈值时保留最新连续后缀，总量 ≤ 预算", async () => {
    const counter = getTokenCounter();
    const history30 = longHistory(30);
    const pipeline = new ContextPipeline({ maxContextTokens: 200, reserveRatio: 0 });
    const result = await pipeline.assemble(makeInput({ history: history30 }));

    const users = result.messages.filter((m) => m.role === "user");
    expect(users.length).toBeLessThan(30);
    expect(users.length).toBeGreaterThan(0);
    expect(users.at(-1)!.id).toBe("h29"); // 最新的永远保留
    // 截断结果是最新连续后缀（不是抽样、不是乱序）
    expect(users.map((m) => m.id)).toEqual(history30.slice(-users.length).map((m) => m.id));
    // mindContext 为空时不产生 system 消息
    expect(result.messages.every((m) => m.role === "user")).toBe(true);
    expect(totalTokens(counter, result)).toBeLessThanOrEqual(pipeline.budgetTokens);
  });
});

describe("大量工具：L6-core 永不裁剪（L6-ext Phase 1 恒空的预留路径）", () => {
  it("预算连工具都放不下时：L3 截断到底后兜底返回，工具一把不少", async () => {
    const counter = getTokenCounter();
    const tools = bigTools(7);
    // 预算比工具本身占用还小 1 token → 任何截断都无法满足预算 → 走兜底
    const pipeline = new ContextPipeline({
      maxContextTokens: counter.countTools(tools) - 1,
      reserveRatio: 0,
    });
    const result = await pipeline.assemble(makeInput({ history: longHistory(30), tools }));

    // Phase 1 所有工具都是 L6-core：永不裁剪，内容逐一相等
    expect(result.tools).toEqual(tools);
    expect(result.tools).toHaveLength(7);
    // L3 已被压到最小档（keep-15 → keep-5），之后无步可降
    const users = result.messages.filter((m) => m.role === "user");
    expect(users).toHaveLength(5);
    expect(users.at(-1)!.id).toBe("h29");
    // 兜底语义：总量仍超预算，但按现状返回而不是死循环或抛错
    expect(totalTokens(counter, result)).toBeGreaterThan(pipeline.budgetTokens);
  });
});

describe("L1 人格文件保留", () => {
  it("长历史 + 超预算：L1/L2 全保留且顺序不变，只截 L3", async () => {
    const pipeline = new ContextPipeline({ maxContextTokens: 300, reserveRatio: 0 });
    const result = await pipeline.assemble(
      makeInput({
        mindContext: "人格：你是小云，一个冷静的助手。",
        mentionDesc: "@小云 被提及，需要回应。",
        history: longHistory(30),
      }),
    );
    const systems = result.messages.filter((m) => m.role === "system");
    expect(systems.map(textOf)).toEqual([
      "人格：你是小云，一个冷静的助手。", // L1
      "@小云 被提及，需要回应。", // L2
    ]);
    const users = result.messages.filter((m) => m.role === "user");
    expect(users.length).toBeLessThan(30);
    expect(users.at(-1)!.id).toBe("h29");
  });
});

describe("降级顺序", () => {
  it("严格按 L5 → L4 → L6-ext → L3 执行，L1/L2/L6-core 永不触碰", () => {
    // Phase 1 的 ContextPipeline.assemble 内部将 l4/l5/l6Ext 恒置空，
    // 公共 API 无法触达这些层，因此直接用 createLayers + selectNextStep
    // 驱动与 pipeline 相同的降级循环，验证完整序列。
    const counter = getTokenCounter();
    const layers = createLayers({
      l1: "人格",
      l2: "@提醒",
      l3: longHistory(30),
      l4: Array.from({ length: 12 }, (_, i) => `检索片段 ${i}`),
      l5: ["话题摘要 A", "话题摘要 B"],
      l6Core: bigTools(2),
      l6Ext: bigTools(4),
    });

    const applied: string[] = [];
    for (;;) {
      const total =
        counter.countMessages(assembleMessages(layers)) +
        counter.countTools([...layers.l6Core, ...layers.l6Ext]);
      if (total <= 0) break; // 预算 0：强制跑完全部可降级步骤
      const step = selectNextStep(layers);
      if (!step) break;
      applied.push(step.name);
      step.apply(layers);
      if (applied.length > 50) throw new Error("降级循环未收敛");
    }

    expect(applied).toEqual([
      "l5:merge",
      "l5:drop",
      "l4:keep-10",
      "l4:keep-5",
      "l4:keep-3",
      "l4:drop",
      "l6ext:halve",
      "l6ext:halve",
      "l6ext:drop",
      "l3:keep-15",
      "l3:keep-5",
    ]);
    // 永不压缩的层原样保留
    expect(layers.l1).toBe("人格");
    expect(layers.l2).toBe("@提醒");
    expect(layers.l6Core).toHaveLength(2);
    // L3 压到最小档，保留最新
    expect(layers.l3.map((m) => m.id)).toEqual(["h25", "h26", "h27", "h28", "h29"]);
  });
});

describe("边界条件", () => {
  it("完全空输入（无 L1/无历史/无工具）：返回空，mock 仍可应答", async () => {
    const { assembled, events } = await runEndToEnd(new ContextPipeline(), makeInput());
    expect(assembled.messages).toEqual([]);
    expect(assembled.tools).toEqual([]);
    expectMockReply(events);
  });

  it("单条消息：远低于预算，原样返回不降级", async () => {
    const pipeline = new ContextPipeline({ maxContextTokens: 1000, reserveRatio: 0 });
    const result = await pipeline.assemble(makeInput({ history: history(1) }));
    expect(result.messages.map((m) => m.id)).toEqual(["h0"]);
  });

  it("刚好等于预算：不降级（总量 ≤ 预算即放行）", async () => {
    const counter = getTokenCounter();
    const input = makeInput({ history: history(16) });
    // 先用超大预算探出原始总量
    const probe = await new ContextPipeline({ maxContextTokens: 1_000_000, reserveRatio: 0 }).assemble(input);
    const total = counter.countMessages(probe.messages) + counter.countTools(probe.tools);

    const result = await new ContextPipeline({ maxContextTokens: total, reserveRatio: 0 }).assemble(input);
    expect(result.messages.filter((m) => m.role === "user")).toHaveLength(16);
  });

  it("刚好超预算 1 token：只触发一步 l3:keep-15（21 > 20）", async () => {
    const counter = getTokenCounter();
    const input = makeInput({ history: history(21) });
    const probe = await new ContextPipeline({ maxContextTokens: 1_000_000, reserveRatio: 0 }).assemble(input);
    const total = counter.countMessages(probe.messages) + counter.countTools(probe.tools);

    const result = await new ContextPipeline({ maxContextTokens: total - 1, reserveRatio: 0 }).assemble(input);
    const users = result.messages.filter((m) => m.role === "user");
    // 21 > 20 → keep-15；丢掉最旧 6 条后必然满足预算（1 token 的缺口远小于 6 条消息）
    expect(users.map((m) => m.id)).toEqual(history(21).slice(-15).map((m) => m.id));
    expect(totalTokens(counter, result)).toBeLessThanOrEqual(total - 1);
  });
});
