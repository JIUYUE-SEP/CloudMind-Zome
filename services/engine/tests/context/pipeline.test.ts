import { describe, it, expect, vi, afterEach } from "vitest";
import type { ChatMessage } from "@mindcloud/shared";
import {
  ContextPipeline,
  DEFAULT_PIPELINE_CONFIG,
  type AssembleInput,
} from "../../src/context/pipeline.js";
import type { TokenCounter } from "../../src/context/token-counter.js";

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
      hotMemoryCount: 2,
    });
    const pipeline = new ContextPipeline({}, new FakeCounter());
    expect(pipeline.budgetTokens).toBe(72000);
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

  it("topicSummaries 注入为 L5 system 消息，位于历史之前", async () => {
    const pipeline = makePipeline(10000);
    const result = await pipeline.assemble(
      makeInput({
        history: history(2),
        topicSummaries: ["[话题摘要] 旧话题A", "[话题摘要] 旧话题B"],
      }),
    );
    const l5 = result.messages.find(
      (m) => m.role === "system" && m.content.some((c) => c.type === "text" && c.text.includes("以下是过去话题的摘要")),
    );
    expect(l5).toBeTruthy();
    const text = l5!.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    expect(text).toContain("旧话题A");
    expect(text).toContain("旧话题B");
    // L5 在 L3 历史之前
    expect(result.messages.indexOf(l5!)).toBeLessThan(
      result.messages.findIndex((m) => m.role === "user"),
    );
  });

  it("超预算时先丢 L5 再截 L3：丢弃摘要后满足预算则历史完整保留", async () => {
    // l3：5 条 × 13 = 65；l5 摘要约 77；预算 100 → 丢 L5 后 65 ≤ 100
    const pipeline = makePipeline(100);
    const result = await pipeline.assemble(
      makeInput({
        history: history(5),
        topicSummaries: ["S".repeat(60)],
      }),
    );
    expect(
      result.messages.some(
        (m) => m.role === "system" && m.content.some((c) => c.type === "text" && c.text.includes("以下是过去话题的摘要")),
      ),
    ).toBe(false);
    expect(result.messages.filter((m) => m.role === "user")).toHaveLength(5);
  });
});

describe("M3：降级可观测日志", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("未超预算：不打任何降级日志", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await makePipeline(10000).assemble(makeInput({ history: history(3) }));
    expect(debug).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("超预算：每步降级打 debug，含 step 名、agentId、预算使用", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
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
    vi.spyOn(console, "debug").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
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
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // l3：25 条 × 13 = 325；l5 ≈ 77；预算 300 → l5:drop（325 仍超）→ l3:keep-15（195）满足
    const result = await makePipeline(300).assemble(
      makeInput({ history: history(25), topicSummaries: ["S".repeat(60)] }),
    );
    expect(result.messages.filter((m) => m.role === "user")).toHaveLength(15);
    const logs = debug.mock.calls.map((c) => String(c[0]));
    expect(logs[0]).toContain("l5:drop");
    expect(logs[1]).toContain("l3:keep-15");
  });

  it("semanticMemories 注入为 L4 system 消息，跨场景带 [来自] 标注", async () => {
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
    const l4 = result.messages.find(
      (m) => m.role === "system" && m.content.some((c) => c.type === "text" && c.text.includes("相关片段")),
    );
    expect(l4).toBeTruthy();
    const text = l4!.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    expect(text).toContain("本场景记忆");
    expect(text).toContain("[来自: session_x] 跨场景记忆");
  });

  it("降级时 L4 按 score 降序保留高相关片段", async () => {
    // 12 条片段（每条内容 10 字符），预算 150 → l4:keep-10 仍超 → l4:keep-5 满足
    const pipeline = makePipeline(150);
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
    const text = result.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content.map((c) => (c.type === "text" ? c.text : "")).join(""))
      .join("");
    for (let i = 0; i < 5; i++) expect(text).toContain(`内容${i}`);
    expect(text).not.toContain("内容5");
    expect(text).not.toContain("内容11");
  });
});
