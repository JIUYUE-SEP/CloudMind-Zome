import { describe, it, expect } from "vitest";
import type { ChatMessage } from "@mindcloud/shared";
import { truncateToolResultText } from "../../src/context/truncate.js";
import type { TokenCounter } from "../../src/context/token-counter.js";

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
    }
    return total;
  }
  countTools(tools: unknown[]): number {
    return JSON.stringify(tools).length;
  }
}

const counter = new FakeCounter();

describe("truncateToolResultText", () => {
  it("未超限：原样返回（同引用，不复制）", () => {
    const text = "short result";
    expect(truncateToolResultText(text, 100, counter)).toBe(text);
  });

  it("刚好等于上限：不截断", () => {
    const text = "x".repeat(100);
    expect(truncateToolResultText(text, 100, counter)).toBe(text);
  });

  it("超限：保留头尾 + 中间省略标记，总量不超过上限", () => {
    const text = "HEAD-" + "m".repeat(1000) + "-TAIL";
    const result = truncateToolResultText(text, 200, counter);
    expect(counter.countText(result)).toBeLessThanOrEqual(200);
    expect(result).toContain("HEAD-");
    expect(result).toContain("-TAIL");
    expect(result).toContain("省略");
    // 头部在标记前，尾部在标记后
    expect(result.indexOf("HEAD-")).toBeLessThan(result.indexOf("省略"));
    expect(result.indexOf("-TAIL")).toBeGreaterThan(result.indexOf("省略"));
  });

  it("上限小到放不下省略标记：退化为纯头部截断，仍不超上限", () => {
    const text = "y".repeat(500);
    const result = truncateToolResultText(text, 10, counter);
    expect(counter.countText(result)).toBeLessThanOrEqual(10);
    expect(result).toBe("y".repeat(10));
  });
});
