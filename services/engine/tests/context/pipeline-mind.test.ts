import { describe, it, expect } from "vitest";
import type { ChatMessage } from "@mindcloud/shared";
import { ContextPipeline, type AssembleInput } from "../../src/context/pipeline.js";
import type { TokenCounter } from "../../src/context/token-counter.js";
import type { MindChunk } from "../../src/mind/mind-files.js";

function textOf(m: ChatMessage): string {
  return m.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}

/** 确定性假计数器：1 字符 = 1 "token"（与 pipeline.test.ts 同款） */
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

function history(n: number): ChatMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `h${i}`,
    role: "user" as const,
    content: [{ type: "text" as const, text: `history ${i}` }],
    createdAt: "2026-07-17T00:00:00Z",
  }));
}

function chunk(heading: string, content: string): MindChunk {
  return { heading, content, raw: `## ${heading}\n${content}` };
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

describe("MIND.md 注入（pipeline 接线）", () => {
  it("mindChunks 组装为 assistant 消息；L1 固定前缀不含 MIND 内容", async () => {
    const pipeline = makePipeline(10000);
    const result = await pipeline.assemble(
      makeInput({
        mindContext: "人格内容",
        history: history(2),
        mindChunks: [chunk("前端状态管理", "决定使用 Zustand。")],
      }),
    );

    const systems = result.messages.filter((m) => m.role === "system");
    expect(systems).toHaveLength(1); // 只有 L1
    expect(textOf(systems[0])).toBe("人格内容");
    expect(textOf(systems[0])).not.toContain("Zustand");

    const mind = result.messages.find((m) => m.id === "mind-recall");
    expect(mind?.role).toBe("assistant");
    expect(textOf(mind!)).toContain("决定使用 Zustand。");
    // 热上下文后面
    expect(result.messages.findIndex((m) => m.id === "mind-recall")).toBeGreaterThan(
      result.messages.findIndex((m) => m.id === "h1"),
    );
  });

  it("缓存前缀稳定：MIND 检索结果变化不改变头部 system 消息", async () => {
    const pipeline = makePipeline(10000);
    const base = { mindContext: "人格内容" };
    const r1 = await pipeline.assemble(
      makeInput({ ...base, sourceId: "s1", history: history(2), mindChunks: [chunk("经验A", "内容A")] }),
    );
    const r2 = await pipeline.assemble(
      makeInput({ ...base, sourceId: "s2", history: history(3), mindChunks: [chunk("经验B", "内容B")] }),
    );
    // 头部 L1 system 内容与位置跨轮完全一致 → 前缀缓存命中
    expect(textOf(r2.messages[0])).toBe(textOf(r1.messages[0]));
    expect(r2.messages[0].role).toBe("system");
  });

  it("超预算时 MIND 消息不被降级（L3 截断后仍在）", async () => {
    // 25 条 × 13 = 325 + MIND ≈ 40；预算 200 → keep-15（235 仍超）→ keep-5（105）满足
    const pipeline = makePipeline(200);
    const result = await pipeline.assemble(
      makeInput({ history: history(25), mindChunks: [chunk("经验", "内容")] }),
    );
    expect(result.messages.filter((m) => m.role === "user")).toHaveLength(5);
    expect(result.messages.some((m) => m.id === "mind-recall")).toBe(true);
  });

  it("mindChunks 缺省时不产生 assistant 消息", async () => {
    const pipeline = makePipeline(10000);
    const result = await pipeline.assemble(makeInput({ history: history(1) }));
    expect(result.messages.every((m) => m.role !== "assistant")).toBe(true);
  });
});
