import { describe, it, expect } from "vitest";
import type { ChatMessage } from "@mindcloud/shared";
import { TopicTracker, MIN_SEGMENT_MESSAGES } from "../../src/memory/topic/tracker.js";

function msg(role: "user" | "assistant", text: string, createdAt: string): ChatMessage {
  return { id: `m_${Math.random().toString(36).slice(2)}`, role, content: [{ type: "text", text }], createdAt };
}

function at(min: number): string {
  return new Date(Date.parse("2026-07-21T10:00:00.000Z") + min * 60_000).toISOString();
}

const config = { enabled: true, windowMinutes: 30, messageThreshold: 5 };

describe("TopicTracker", () => {
  it("消息数达到阈值时关闭当前话题并产出 segment", () => {
    const tracker = new TopicTracker(config);
    let closed: ReturnType<TopicTracker["onTurnAppended"]> = null;
    for (let i = 0; i < 4; i++) {
      closed = tracker.onUserMessage(msg("user", `问题${i}`, at(i)), "s1") ?? closed;
      closed = tracker.onTurnAppended([msg("assistant", `回答${i}`, at(i))], "s1") ?? closed;
    }
    // 4 user + 4 assistant = 8 条，第 5 条（阈值）在追加时已触发
    expect(closed).not.toBeNull();
    const seg = closed!;
    expect(seg.messages.length).toBeGreaterThanOrEqual(5);
    expect(seg.sourceId).toBe("s1");
    expect(seg.topicId).toMatch(/^tp_/);
  });

  it("时间间隔超窗时关闭旧话题，新消息归入新话题", () => {
    const tracker = new TopicTracker(config);
    for (let i = 0; i < MIN_SEGMENT_MESSAGES; i++) {
      tracker.onUserMessage(msg("user", `旧话题${i}`, at(i)), "s1");
    }
    const closed = tracker.onUserMessage(msg("user", "我回来了", at(100)), "s1");
    expect(closed).not.toBeNull();
    expect(closed!.messages).toHaveLength(MIN_SEGMENT_MESSAGES);

    // 新话题从头累计
    const again = tracker.onUserMessage(msg("user", "继续新话题", at(101)), "s1");
    expect(again).toBeNull();
  });

  it("太短的话题产出 archiveOnly segment（不压缩仅归档）", () => {
    const tracker = new TopicTracker(config);
    tracker.onUserMessage(msg("user", "只说一句", at(0)), "s1");
    const closed = tracker.onUserMessage(msg("user", "换个话题", at(1)), "s1");
    expect(closed).not.toBeNull();
    expect(closed!.archiveOnly).toBe(true);
    expect(closed!.messages).toHaveLength(1);
  });

  it("达到 MIN_SEGMENT_MESSAGES 的话题正常压缩（非 archiveOnly）", () => {
    const tracker = new TopicTracker(config);
    for (let i = 0; i < MIN_SEGMENT_MESSAGES; i++) {
      tracker.onUserMessage(msg("user", `内容${i}`, at(i)), "s1");
    }
    const closed = tracker.onUserMessage(msg("user", "换个话题", at(10)), "s1");
    expect(closed!.archiveOnly).toBe(false);
  });

  it("切换词触发关闭", () => {
    const tracker = new TopicTracker(config);
    for (let i = 0; i < MIN_SEGMENT_MESSAGES; i++) {
      tracker.onUserMessage(msg("user", `内容${i}`, at(i)), "s1");
    }
    const closed = tracker.onUserMessage(msg("user", "换个话题，说说天气", at(5)), "s1");
    expect(closed).not.toBeNull();
  });

  it("enabled=false 时不产出 segment", () => {
    const tracker = new TopicTracker({ ...config, enabled: false });
    for (let i = 0; i < 10; i++) {
      expect(tracker.onUserMessage(msg("user", `消息${i}`, at(i * 60)), "s1")).toBeNull();
      expect(tracker.onTurnAppended([msg("assistant", `回复${i}`, at(i * 60))], "s1")).toBeNull();
    }
  });

  it("segment 携带起止时间、消息 id 与关闭时的场景", () => {
    const tracker = new TopicTracker(config);
    const first = msg("user", "开始", at(0));
    tracker.onUserMessage(first, "s1");
    for (let i = 1; i < MIN_SEGMENT_MESSAGES; i++) {
      tracker.onUserMessage(msg("user", `继续${i}`, at(i)), "s2", "另一个会话");
    }
    const closed = tracker.onUserMessage(msg("user", "换个话题", at(10)), "s2", "另一个会话");
    expect(closed!.startedAt).toBe(first.createdAt);
    expect(closed!.endedAt).not.toBe(first.createdAt);
    expect(closed!.messages.map((m) => m.id)).toContain(first.id);
    expect(closed!.sourceId).toBe("s2");
    expect(closed!.sourceName).toBe("另一个会话");
  });
});
