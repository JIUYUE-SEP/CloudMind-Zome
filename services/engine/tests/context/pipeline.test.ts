import { logger } from "../../src/logger.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import type { ChatMessage } from "@mindcloud/shared";
import {
  ContextPipeline,
  DEFAULT_PIPELINE_CONFIG,
  type AssembleInput,
} from "../../src/context/pipeline.js";
import type { TopicSummary } from "../../src/context/layers.js";
import type { TokenCounter } from "../../src/context/token-counter.js";

function textOf(m: ChatMessage): string {
  return m.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}

function topicSummary(id: string, text: string): TopicSummary {
  // createdAt 早于 history(2026-07-17)：归并后摘要消息排在历史之前
  return { id, label: id, text, createdAt: "2026-07-10T00:00:00Z" };
}

/** 确定性假计数器：1 字符 = 1 "token"，便于精确控制预算 */
class FakeCounter implements TokenCounter {
  countText(text: string): number {
    return text.length;
  }
  countMessages(messages: ChatMessage[]): number {
    let total = 0;
    for (const m of messages) {
      total += 4;
      for (const c of m.content) total += c.type === "text" ? c.text.length : c.think.length;
      if (m.toolCalls) total += JSON.stringify(m.toolCalls).length;
    }
    return total;
  }
  countTools(tools: unknown[]): number {
    return JSON.stringify(tools).length;
  }
}

function history(n: number, text = "history"): ChatMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `h${i}`,
    role: "user" as const,
    content: [{ type: "text" as const, text: `${text} ${i}` }],
    createdAt: "2026-07-17T00:00:00Z",
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

function makePipeline(maxContextTokens: number): ContextPipeline {
  return new ContextPipeline({ maxContextTokens, reserveRatio: 0 }, new FakeCounter());
}

describe("ContextPipeline", () => {
  it("默认配置：80000 tokens + 10% reserveRatio，预算 72000", () => {
    expect(DEFAULT_PIPELINE_CONFIG).toEqual({
      maxContextTokens: 80000,
      reserveRatio: 0.1,
    });
    const pipeline = new ContextPipeline({}, new FakeCounter());
    expect(pipeline.budgetTokens).toBe(72000);
  });

  it("H2：syncMaxContextTokens 热更窗口（同值幂等，不重建实例）", () => {
    const pipeline = makePipeline(80_000);
    expect(pipeline.budgetTokens).toBe(80_000);
    expect(pipeline.maxContextTokens).toBe(80_000);

    expect(pipeline.syncMaxContextTokens(32_000)).toBe(true);
    expect(pipeline.maxContextTokens).toBe(32_000);
    expect(pipeline.budgetTokens).toBe(32_000);

    // 同值幂等：返回 false，预算不再变化
    expect(pipeline.syncMaxContextTokens(32_000)).toBe(false);
    expect(pipeline.budgetTokens).toBe(32_000);
  });

  it("F3：syncMaxContextTokens 拒绝非正数/NaN/Infinity（预算不变，warn 留痕）", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const pipeline = makePipeline(80_000);
      for (const bad of [0, -1, NaN, Infinity, -Infinity]) {
        expect(pipeline.syncMaxContextTokens(bad)).toBe(false);
        expect(pipeline.maxContextTokens).toBe(80_000);
        expect(pipeline.budgetTokens).toBe(80_000);
      }
      expect(warn).toHaveBeenCalledTimes(5);
    } finally {
      warn.mockRestore();
    }
  });

  it("未超预算时原样组装：L1 system + 全部 history，tools 不变", async () => {
    const pipeline = makePipeline(10000);
    const tools = [{ type: "function", function: { name: "read_file" } }];
    const result = await pipeline.assemble(
      makeInput({ mindContext: "人格", history: history(3), tools }),
    );
    expect(result.messages[0].role).toBe("system");
    expect(result.messages.slice(1)).toHaveLength(3);
    expect(result.tools).toEqual(tools); // 内容一致（管线内部持有副本，不改调用方数组）
  });

  it("超预算时按 L3 逐级截断直到满足预算", async () => {
    // 25 条 × 11 单位 ≈ 275；预算 100 → keep-15（165）→ 仍超 → keep-5（55）→ 满足
    const pipeline = makePipeline(100);
    const result = await pipeline.assemble(makeInput({ history: history(25) }));
    const users = result.messages.filter((m) => m.role === "user");
    expect(users).toHaveLength(5);
    expect(users.at(-1)!.id).toBe("h24"); // 保留最新
  });

  it("tools 计入预算：工具描述占用大头时也会触发 L3 截断", async () => {
    // 12 条 × 11 = 132，tools JSON = 60，预算 150 → 超 → keep-5 → 55+60=115 满足
    const pipeline = makePipeline(150);
    const bigTool = { type: "function", function: { name: "x".repeat(45) } }; // JSON ≈ 60
    const result = await pipeline.assemble(
      makeInput({ history: history(12), tools: [bigTool] }),
    );
    expect(result.messages.filter((m) => m.role === "user")).toHaveLength(5);
    expect(result.tools).toHaveLength(1); // Phase 1 全部工具视为 L6-core，不裁剪
  });

  it("兜底：预算极小且无可降层时按现状返回，不死循环、不碰 L1", async () => {
    const pipeline = makePipeline(10);
    const result = await pipeline.assemble(
      makeInput({ mindContext: "x".repeat(100), history: history(2) }),
    );
    const systems = result.messages.filter((m) => m.role === "system");
    expect(systems).toHaveLength(1); // L1 永不压缩
    expect(result.messages.filter((m) => m.role === "user")).toHaveLength(2);
  });

  it("mentionDesc 映射为 L2 system 消息且永不降级", async () => {
    const pipeline = makePipeline(50);
    const result = await pipeline.assemble(
      makeInput({
        mindContext: "人格",
        mentionDesc: "@提醒",
        history: history(25),
      }),
    );
    const systems = result.messages.filter((m) => m.role === "system");
    expect(systems).toHaveLength(2); // L1/L2 全保留
  });

  it("topicSummaries 伪装成 user 历史消息注入（自然化、非 system 元信息）", async () => {
    const pipeline = makePipeline(10000);
    const result = await pipeline.assemble(
      makeInput({
        history: history(2),
        topicSummaries: [topicSummary("旧话题A", "旧话题A的摘要"), topicSummary("旧话题B", "旧话题B的摘要")],
      }),
    );
    expect(result.messages.every((m) => m.role !== "system")).toBe(true);
    const users = result.messages.filter((m) => m.role === "user").map(textOf);
    expect(users.some((t) => t.includes("用户之前聊过") && t.includes("旧话题A的摘要"))).toBe(true);
    expect(users.some((t) => t.includes("旧话题B的摘要"))).toBe(true);
    // 摘要 createdAt(07-10) 早于 history(07-17)：按时间归并排在历史之前
    const topicIdx = result.messages.findIndex((m) => m.id === "topic-旧话题A");
    const historyIdx = result.messages.findIndex((m) => m.id === "h0");
    expect(topicIdx).toBeGreaterThanOrEqual(0);
    expect(topicIdx).toBeLessThan(historyIdx);
  });

  it("超预算时先丢 L5 再截 L3：丢弃摘要后满足预算则历史完整保留", async () => {
    // l3：5 条 × 13 = 65；l5 摘要消息约 100；预算 100 → 丢 L5 后 65 ≤ 100
    const pipeline = makePipeline(100);
    const result = await pipeline.assemble(
      makeInput({
        history: history(5),
        topicSummaries: [topicSummary("tp1", "S".repeat(60))],
      }),
    );
    expect(result.messages.some((m) => m.id === "topic-tp1")).toBe(false);
    expect(result.messages.filter((m) => m.role === "user")).toHaveLength(5);
  });
});

describe("M3：降级可观测日志", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("未超预算：不打任何降级日志", async () => {
    const debug = vi.spyOn(logger, "debug").mockImplementation(() => {});
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    await makePipeline(10000).assemble(makeInput({ history: history(3) }));
    expect(debug).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("超预算：每步降级打 debug，含 step 名、agentId、预算使用", async () => {
    const debug = vi.spyOn(logger, "debug").mockImplementation(() => {});
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    // 25 条 → keep-15（>20）→ 仍超 → keep-5（15>10）→ 满足
    await makePipeline(100).assemble(makeInput({ agentId: "agent-x", history: history(25) }));
    const logs = debug.mock.calls.map((c) => String(c[0]));
    expect(logs).toHaveLength(2);
    expect(logs[0]).toContain("l3:keep-15");
    expect(logs[1]).toContain("l3:keep-5");
    expect(logs[0]).toContain("agent-x");
    expect(logs[0]).toMatch(/total=\d+.*budget=\d+/);
  });

  it("兜底（无可再降）：打 warn 一次，含 agentId 与 total/budget", async () => {
    vi.spyOn(logger, "debug").mockImplementation(() => {});
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    await makePipeline(10).assemble(
      makeInput({ agentId: "agent-y", mindContext: "x".repeat(100), history: history(2) }),
    );
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0][0]);
    expect(msg).toContain("agent-y");
    expect(msg).toMatch(/total=\d+/);
    expect(msg).toMatch(/budget=\d+/);
  });

  it("降级顺序：l5:drop 先于 l3 截断", async () => {
    const debug = vi.spyOn(logger, "debug").mockImplementation(() => {});
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    // l3：25 条 × 13 = 325；l5 ≈ 100；预算 300 → l5:drop（325 仍超）→ l3:keep-15（195）满足
    const result = await makePipeline(300).assemble(
      makeInput({ history: history(25), topicSummaries: [topicSummary("tp1", "S".repeat(60))] }),
    );
    expect(result.messages.filter((m) => m.role === "user")).toHaveLength(15);
    const logs = debug.mock.calls.map((c) => String(c[0]));
    expect(logs[0]).toContain("l5:drop");
    expect(logs[1]).toContain("l3:keep-15");
  });

  it("semanticMemories 伪装成 user 历史消息，跨场景自然化标注", async () => {
    const pipeline = makePipeline(10000);
    const result = await pipeline.assemble(
      makeInput({
        history: history(1),
        semanticMemories: [
          { id: "m1", content: "本场景记忆", score: 0.9, createdAt: "2026-07-20T00:00:00Z" },
          { id: "m2", content: "跨场景记忆", score: 0.8, source: "session_x", createdAt: "2026-07-20T00:00:00Z" },
        ],
      }),
    );
    expect(result.messages.every((m) => m.role !== "system")).toBe(true);
    const users = result.messages.filter((m) => m.role === "user").map(textOf);
    expect(users.some((t) => t.includes("用户之前提到过") && t.includes("本场景记忆"))).toBe(true);
    expect(users.some((t) => t.includes("另一个对话") && t.includes("跨场景记忆"))).toBe(true);
    // 不再有 [来自: ...] 元信息标注
    expect(users.join("")).not.toContain("[来自:");
  });

  it("降级时 L4 按 score 降序保留高相关片段", async () => {
    // 12 条片段：m10(0.5)/m11(0.45) 被置信度过滤，剩 10 条（6 high + 4 fuzzy）。
    // 预算 300：10 条 ≈ 600 超 → l4:keep-5（5 条 high ≈ 245）满足
    const pipeline = makePipeline(300);
    const result = await pipeline.assemble(
      makeInput({
        history: [],
        semanticMemories: Array.from({ length: 12 }, (_, i) => ({
          id: `m${i}`,
          content: `内容${i}${"x".repeat(6)}`,
          score: 1 - i * 0.05,
          createdAt: "2026-07-20T00:00:00Z",
        })),
      }),
    );
    const text = result.messages.map(textOf).join("");
    for (let i = 0; i < 5; i++) expect(text).toContain(`内容${i}`);
    expect(text).not.toContain("内容5");
    expect(text).not.toContain("内容11");
  });
});

describe("最终设计：置信度过滤 / 多轮去重 / 失败告知 / 缓存前缀", () => {
  it("score ≤ 0.5 的记忆被过滤，不参与注入", async () => {
    const pipeline = makePipeline(10000);
    const result = await pipeline.assemble(
      makeInput({
        semanticMemories: [
          { id: "low", content: "低相关记忆", score: 0.5, createdAt: "2026-07-20T00:00:00Z" },
          { id: "high", content: "高相关记忆", score: 0.9, createdAt: "2026-07-20T00:00:00Z" },
        ],
      }),
    );
    const all = result.messages.map(textOf).join("");
    expect(all).not.toContain("低相关记忆");
    expect(all).toContain("高相关记忆");
  });

  it("多轮去重：同一会话已注入的记忆与摘要不重复注入", async () => {
    const pipeline = makePipeline(10000);
    const input = makeInput({
      sourceId: "sess-1",
      semanticMemories: [
        { id: "m1", content: "记忆一", score: 0.9, createdAt: "2026-07-20T00:00:00Z" },
      ],
      topicSummaries: [topicSummary("tp1", "摘要一")],
    });
    const first = await pipeline.assemble(input);
    expect(first.messages.map(textOf).join("")).toContain("记忆一");
    expect(first.messages.map(textOf).join("")).toContain("摘要一");

    const second = await pipeline.assemble(input);
    const all = second.messages.map(textOf).join("");
    expect(all).not.toContain("记忆一");
    expect(all).not.toContain("摘要一");
  });

  it("去重按会话隔离：新会话可再次注入同一记忆", async () => {
    const pipeline = makePipeline(10000);
    const memory = { id: "m1", content: "记忆一", score: 0.9, createdAt: "2026-07-20T00:00:00Z" };
    await pipeline.assemble(makeInput({ sourceId: "sess-1", semanticMemories: [memory] }));
    const other = await pipeline.assemble(makeInput({ sourceId: "sess-2", semanticMemories: [memory] }));
    expect(other.messages.map(textOf).join("")).toContain("记忆一");
  });

  it("被降级丢弃的记忆不计入已注入，下一轮预算宽裕时仍可注入", async () => {
    const pipeline = makePipeline(150);
    const memory = { id: "m1", content: "珍贵记忆", score: 0.9, createdAt: "2026-07-20T00:00:00Z" };
    // 第一轮：25 条 history 挤爆预算，L4 走 l4:drop 被整体丢弃
    const squeezed = await pipeline.assemble(
      makeInput({ history: history(25), semanticMemories: [memory] }),
    );
    expect(squeezed.messages.map(textOf).join("")).not.toContain("珍贵记忆");
    // 第二轮：history 变短，预算宽裕 → 记忆应注入（未被误标记为已注入）
    const relaxed = await pipeline.assemble(
      makeInput({ history: history(2), semanticMemories: [memory] }),
    );
    expect(relaxed.messages.map(textOf).join("")).toContain("珍贵记忆");
  });

  it("检索失败透传：尾随 system 消息明确告知", async () => {
    const pipeline = makePipeline(10000);
    const result = await pipeline.assemble(
      makeInput({ history: history(1), retrievalFailed: true }),
    );
    const last = result.messages.at(-1)!;
    expect(last.role).toBe("system");
    expect(textOf(last)).toContain("记忆检索暂时不可用");
    // 固定前缀不被污染：失败提示在 messages 末尾
    expect(result.messages.findIndex((m) => m.id === "h0")).toBeLessThan(
      result.messages.length - 1,
    );
  });

  it("缓存前缀稳定：L4/L5/历史变化不改变头部 system 消息内容与位置", async () => {
    const pipeline = makePipeline(10000);
    const base = { mindContext: "人格内容", mentionDesc: "@提醒" };
    const r1 = await pipeline.assemble(
      makeInput({
        ...base,
        sourceId: "s1",
        history: history(2),
        semanticMemories: [
          { id: "m1", content: "记忆一", score: 0.9, createdAt: "2026-07-20T00:00:00Z" },
        ],
      }),
    );
    const r2 = await pipeline.assemble(
      makeInput({
        ...base,
        sourceId: "s2",
        history: history(3),
        semanticMemories: [
          { id: "m2", content: "完全不同的记忆", score: 0.95, createdAt: "2026-07-21T00:00:00Z" },
        ],
        topicSummaries: [topicSummary("tp9", "另一个摘要")],
      }),
    );
    // 头部两条 system（L1/L2）内容与位置完全一致 → 前缀缓存命中
    expect(r1.messages[0].role).toBe("system");
    expect(textOf(r1.messages[0])).toBe("人格内容");
    expect(r1.messages[1].role).toBe("system");
    expect(textOf(r1.messages[1])).toBe("@提醒");
    expect(textOf(r2.messages[0])).toBe(textOf(r1.messages[0]));
    expect(textOf(r2.messages[1])).toBe(textOf(r1.messages[1]));
    expect(r2.messages[0].role).toBe("system");
    expect(r2.messages[1].role).toBe("system");
  });
});
