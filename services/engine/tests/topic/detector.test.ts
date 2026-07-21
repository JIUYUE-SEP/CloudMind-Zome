import { describe, it, expect } from "vitest";
import type { ChatMessage } from "@mindcloud/shared";
import { detectTopicBoundary } from "../../src/memory/topic/detector.js";

function msg(role: "user" | "assistant", text: string, createdAt: string): ChatMessage {
  return { id: Math.random().toString(36).slice(2), role, content: [{ type: "text", text }], createdAt };
}

const T0 = "2026-07-21T10:00:00.000Z";

function minutesAfter(iso: string, min: number): string {
  return new Date(Date.parse(iso) + min * 60_000).toISOString();
}

const base = { windowMinutes: 30, messageThreshold: 20 };

describe("detectTopicBoundary", () => {
  it("时间间隔未超窗口：同话题", () => {
    const prev = msg("assistant", "好的", T0);
    const next = msg("user", "继续", minutesAfter(T0, 29));
    expect(detectTopicBoundary({ prevMessage: prev, newMessage: next, currentCount: 5, ...base })).toBe("same");
  });

  it("时间间隔超过窗口：新话题", () => {
    const prev = msg("assistant", "好的", T0);
    const next = msg("user", "在吗", minutesAfter(T0, 31));
    expect(detectTopicBoundary({ prevMessage: prev, newMessage: next, currentCount: 5, ...base })).toBe("new_topic");
  });

  it("消息数达到阈值：新话题", () => {
    const prev = msg("assistant", "嗯", T0);
    const next = msg("assistant", "接着说", minutesAfter(T0, 1));
    expect(detectTopicBoundary({ prevMessage: prev, newMessage: next, currentCount: 20, ...base })).toBe("new_topic");
    expect(detectTopicBoundary({ prevMessage: prev, newMessage: next, currentCount: 19, ...base })).toBe("same");
  });

  it("用户显式切换词命中：新话题", () => {
    const prev = msg("assistant", "好的", T0);
    const next = msg("user", "好了，换个话题，聊聊晚饭", minutesAfter(T0, 1));
    expect(detectTopicBoundary({ prevMessage: prev, newMessage: next, currentCount: 5, ...base })).toBe("new_topic");
  });

  it("普通提及「话题」不命中切换词：同话题", () => {
    const prev = msg("assistant", "好的", T0);
    const next = msg("user", "这个话题很有意思，继续深入", minutesAfter(T0, 1));
    expect(detectTopicBoundary({ prevMessage: prev, newMessage: next, currentCount: 5, ...base })).toBe("same");
  });

  it("切换词只在 user 消息上生效", () => {
    const prev = msg("user", "嗯", T0);
    const next = msg("assistant", "好的，换个话题来说", minutesAfter(T0, 1));
    expect(detectTopicBoundary({ prevMessage: prev, newMessage: next, currentCount: 5, ...base })).toBe("same");
  });

  it("没有上一条消息（话题刚开始）：同话题", () => {
    const next = msg("user", "你好", T0);
    expect(detectTopicBoundary({ newMessage: next, currentCount: 0, ...base })).toBe("same");
  });

  it("createdAt 无法解析时按同话题处理", () => {
    const prev = msg("assistant", "好的", "not-a-date");
    const next = msg("user", "继续", "also-not-a-date");
    expect(detectTopicBoundary({ prevMessage: prev, newMessage: next, currentCount: 5, ...base })).toBe("same");
  });
});
