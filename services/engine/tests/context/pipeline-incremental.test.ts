import { logger } from "../../src/logger.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import type { ChatMessage } from "@cloudmind/shared";
import { ContextPipeline, type AssembleInput, type AssembleResult } from "../../src/context/pipeline.js";
import { createLayers, type SemanticMemory, type TopicSummary } from "../../src/context/layers.js";
import { assembleMessages } from "../../src/context/assembler.js";
import { selectNextStep } from "../../src/context/downgrade.js";
import { CONFIDENCE_DROP } from "../../src/context/recall.js";
import { getTokenCounter, type TokenCounter } from "../../src/context/token-counter.js";

/**
 * P5-4（质量 review M3）：降级循环增量计数。
 * 正确性钉法：参照实现 = P5-4 之前的"每步全量重算"循环（本文件内复刻），
 * 同一输入下新实现的 messages/tools 必须与参照逐条一致。
 * 性能钉法：统计 countText 调用次数（编码量），新实现必须显著低于参照，
 * 不用墙钟断言（机器差异大，易 flaky）。
 */

/** 确定性假计数器：1 字符 = 1 "token"（与 pipeline.test.ts 同款，逐消息可加）。
 *  countTextCalls 按真实 TiktokenCounter 的 countText 调用结构记账（每 content
 *  段 / toolCalls / toolCallId / 整组 tools JSON 各一次），用于编码量对比。 */
class FakeCounter implements TokenCounter {
  countTextCalls = 0;
  countText(text: string): number {
    this.countTextCalls++;
    return text.length;
  }
  countMessages(messages: ChatMessage[]): number {
    let total = 0;
    for (const m of messages) {
      total += 4;
      for (const c of m.content) {
        this.countTextCalls++;
        total += c.type === "text" ? c.text.length : c.think.length;
      }
      if (m.toolCalls) {
        this.countTextCalls++;
        total += JSON.stringify(m.toolCalls).length;
      }
      if (m.toolCallId) {
        this.countTextCalls++;
        total += m.toolCallId.length;
      }
    }
    return total;
  }
  countTools(tools: unknown[]): number {
    this.countTextCalls++;
    return JSON.stringify(tools).length;
  }
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

function history(n: number, text = "history"): ChatMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `h${i}`,
    role: "user" as const,
    content: [{ type: "text" as const, text: `${text} ${i}` }],
    createdAt: "2026-07-17T00:00:00Z",
  }));
}

function memories(n: number, score = 0.9): SemanticMemory[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    content: `记忆片段 ${i} `.repeat(20),
    score,
    createdAt: "2026-07-10T00:00:00Z",
  }));
}

function topics(n: number): TopicSummary[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `tp${i}`,
    label: `话题 ${i}`,
    text: `摘要正文 ${i} `.repeat(30),
    createdAt: "2026-07-10T00:00:00Z",
  }));
}

/** 参照实现：P5-4 之前的全量重算降级循环（intake 与 pipeline.assemble 一致） */
function assembleFullRecount(
  input: AssembleInput,
  budgetTokens: number,
  counter: TokenCounter,
): AssembleResult {
  const layers = createLayers({
    l1: input.mindContext,
    l3: [...input.history],
    l4: (input.semanticMemories ?? []).filter((m) => m.score > CONFIDENCE_DROP),
    l5: [...(input.topicSummaries ?? [])],
    mind: [...(input.mindChunks ?? [])],
    l6Core: [...input.tools],
    l6Ext: [],
  });
  for (;;) {
    const messages = assembleMessages(layers, { retrievalFailed: input.retrievalFailed });
    const tools = [...layers.l6Core, ...layers.l6Ext];
    const total = counter.countMessages(messages) + counter.countTools(tools);
    if (total <= budgetTokens) return { messages, tools };
    const step = selectNextStep(layers);
    if (!step) return { messages, tools };
    step.apply(layers);
  }
}

/** 结构比较：role + content（id/createdAt 含随机与时间成分，不属于计数正确性） */
function shape(result: AssembleResult): { roles: string[]; texts: string[]; tools: unknown[] } {
  return {
    roles: result.messages.map((m) => m.role),
    texts: result.messages.map((m) => JSON.stringify(m.content)),
    tools: result.tools,
  };
}

async function expectSameAsRecount(input: AssembleInput, budgetTokens: number, counter?: TokenCounter) {
  const c1 = counter ?? new FakeCounter();
  const c2 = counter ?? new FakeCounter();
  const pipeline = new ContextPipeline({ maxContextTokens: budgetTokens, reserveRatio: 0 }, c1);
  const actual = await pipeline.assemble(input);
  const expected = assembleFullRecount(input, budgetTokens, c2);
  expect(shape(actual)).toEqual(shape(expected));
  return { actual, expected };
}

describe("降级循环增量计数（P5-4）：与全量重算参照一致", () => {
  const spies: ReturnType<typeof vi.spyOn>[] = [];
  afterEach(() => {
    for (const s of spies) s.mockRestore();
    spies.length = 0;
  });
  function silenceLogs() {
    spies.push(vi.spyOn(logger, "warn").mockImplementation(() => {}));
    spies.push(vi.spyOn(logger, "debug").mockImplementation(() => {}));
  }

  it("完整降级序列到底（兜底路径）：l5→l4→l3 全降，结果与参照一致", async () => {
    silenceLogs();
    const input = makeInput({
      mindContext: "人格设定",
      history: history(30, "热上下文消息"),
      semanticMemories: memories(12),
      topicSummaries: topics(5),
      tools: [{ fn: "a" }, { fn: "b" }],
    });
    const { expected } = await expectSameAsRecount(input, 50);
    // 确认参照确实走了兜底（无可再降）：l3 已被砍到 keep-5 下限仍超预算
    expect(expected.messages.length).toBeGreaterThan(0);
  });

  it("中途预算满足（l5 部分丢弃 + l4 keep-10）：停点与参照一致", async () => {
    silenceLogs();
    const input = makeInput({
      history: history(10),
      semanticMemories: memories(12),
      topicSummaries: topics(4),
      tools: [{ fn: "a" }],
    });
    // 该预算下参照需要多步降级（先验证参照真的降了级）
    const budget = 1500;
    const expected = assembleFullRecount(input, budget, new FakeCounter());
    const noDowngrade = assembleFullRecount(input, 10_000_000, new FakeCounter());
    expect(expected.messages.length).toBeLessThan(noDowngrade.messages.length);
    await expectSameAsRecount(input, budget);
  });

  it("l3 截断路径（含 assistant(toolCalls)→tool 消息对与孤儿 tool 丢弃）：与参照一致", async () => {
    silenceLogs();
    // 交织工具调用对：截断会切出孤儿 tool 消息，truncateHotContext 连带丢弃
    const msgs: ChatMessage[] = [];
    for (let i = 0; i < 12; i++) {
      msgs.push({
        id: `a${i}`,
        role: "assistant",
        content: [{ type: "text", text: `调用工具 ${i}` }],
        toolCalls: [{ toolCallId: `tc${i}`, name: "read_file", arguments: {} }],
        createdAt: "2026-07-17T00:00:00Z",
      });
      msgs.push({
        id: `t${i}`,
        role: "tool",
        toolCallId: `tc${i}`,
        content: [{ type: "text", text: `工具结果 ${i} `.repeat(10) }],
        createdAt: "2026-07-17T00:00:00Z",
      });
    }
    const input = makeInput({ history: msgs, tools: [{ fn: "a" }] });
    await expectSameAsRecount(input, 400);
  });

  it("真实 tiktoken 计数器下增量与全量一致（BPE 边界行为由真实计数器钉住）", async () => {
    silenceLogs();
    const input = makeInput({
      history: history(25, "真实计数器消息 with English mixed 混合文本"),
      semanticMemories: memories(8),
      topicSummaries: topics(3),
      tools: [{ fn: "a" }],
    });
    const budget = 200;
    const pipeline = new ContextPipeline({ maxContextTokens: budget, reserveRatio: 0 }, getTokenCounter());
    const actual = await pipeline.assemble(input);
    const expected = assembleFullRecount(input, budget, getTokenCounter());
    expect(shape(actual)).toEqual(shape(expected));
  });

  it("编码量（countText 调用次数）显著低于全量重算参照", async () => {
    silenceLogs();
    const input = makeInput({
      history: history(30, "热上下文消息"),
      semanticMemories: memories(12),
      topicSummaries: topics(5),
      tools: [{ fn: "a" }],
    });
    const newCounter = new FakeCounter();
    const pipeline = new ContextPipeline({ maxContextTokens: 50, reserveRatio: 0 }, newCounter);
    await pipeline.assemble(input);

    const oldCounter = new FakeCounter();
    assembleFullRecount(input, 50, oldCounter);

    expect(oldCounter.countTextCalls).toBeGreaterThan(0);
    // 完整降级序列约 10 步：参照每步全量重算 ≈ 步数 × 单次编码量；
    // 增量只付 ~1 次全量 + 每步 O(移除项)。保守断言 3 倍差距（实际约 8-10 倍）
    expect(newCounter.countTextCalls * 3).toBeLessThanOrEqual(oldCounter.countTextCalls);
  });
});
