import { describe, it, expect } from "vitest";
import type { ChatMessage } from "@cloudmind/shared";
import { TiktokenCounter, getTokenCounter } from "../../src/context/token-counter.js";

function msg(text: string, role: ChatMessage["role"] = "user"): ChatMessage {
  return {
    id: "m1",
    role,
    content: [{ type: "text", text }],
    createdAt: "2026-07-17T00:00:00Z",
  };
}

describe("TiktokenCounter", () => {
  const counter = new TiktokenCounter();

  it("countText 空串为 0", () => {
    expect(counter.countText("")).toBe(0);
  });

  it("countText 对英文使用真实 tokenizer（hello world = 2 tokens）", () => {
    expect(counter.countText("hello world")).toBe(2);
  });

  it("countText 对中文准确计数（不是字符数/4 的估算）", () => {
    const text = "你好，世界";
    const count = counter.countText(text);
    // cl100k 下中文字符通常 1-2 token/字；字符数/4 会得出 1，明显失真
    expect(count).toBeGreaterThan(2);
  });

  it("countMessages 累计 text/think/toolCalls 与每条消息的开销", () => {
    const messages: ChatMessage[] = [
      msg("hello"),
      {
        id: "m2",
        role: "assistant",
        content: [{ type: "think", think: "thinking..." }],
        toolCalls: [{ toolCallId: "tc1", name: "read_file", arguments: { path: "a.ts" } }],
        createdAt: "2026-07-17T00:00:00Z",
      },
    ];
    const total = counter.countMessages(messages);
    const manual =
      counter.countText("hello") +
      counter.countText("thinking...") +
      counter.countText(JSON.stringify(messages[1].toolCalls)) +
      counter.countText("user") +
      counter.countText("assistant") +
      2 * TiktokenCounter.MESSAGE_OVERHEAD;
    expect(total).toBe(manual);
  });

  it("H3：countMessages stripThinking 剥掉 think 块（text/role/开销仍计入）", () => {
    const messages: ChatMessage[] = [
      msg("hello"),
      {
        id: "m2",
        role: "assistant",
        content: [
          { type: "think", think: "x".repeat(2000) },
          { type: "text", text: "answer" },
        ],
        createdAt: "2026-07-17T00:00:00Z",
      },
    ];
    const full = counter.countMessages(messages);
    const stripped = counter.countMessages(messages, { stripThinking: true });
    // think 块被剥离：stripped 只含 hello/answer/role/开销
    expect(stripped).toBe(
      counter.countMessages([
        msg("hello"),
        {
          id: "m2",
          role: "assistant",
          content: [{ type: "text", text: "answer" }],
          createdAt: "2026-07-17T00:00:00Z",
        },
      ]),
    );
    // 旧口径（含 think）更大：2000 字符的 think 块在 cl100k 下也有 100+ tokens
    expect(full).toBeGreaterThan(stripped + 100);
  });

  it("countMessages 空数组为 0", () => {
    expect(counter.countMessages([])).toBe(0);
  });

  it("countTools 按 JSON 序列化计数", () => {
    const tools = [{ type: "function", function: { name: "read_file", description: "read" } }];
    expect(counter.countTools(tools)).toBe(counter.countText(JSON.stringify(tools)));
  });

  it("countTools 空数组接近 0（只有 [] 的 token）", () => {
    expect(counter.countTools([])).toBeLessThanOrEqual(3);
  });

  it("getTokenCounter 返回共享单例", () => {
    expect(getTokenCounter()).toBe(getTokenCounter());
  });
});
