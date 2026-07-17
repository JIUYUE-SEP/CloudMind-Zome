import { describe, it, expect } from "vitest";
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
      semanticCandidateCount: 10,
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

  it("personalityDesc/mentionDesc 映射为 L1.5/L2 system 消息且永不降级", async () => {
    const pipeline = makePipeline(50);
    const result = await pipeline.assemble(
      makeInput({
        mindContext: "人格",
        personalityDesc: "群聊行为指令",
        mentionDesc: "@提醒",
        history: history(25),
      }),
    );
    const systems = result.messages.filter((m) => m.role === "system");
    expect(systems).toHaveLength(3); // L1/L1.5/L2 全保留
  });
});
