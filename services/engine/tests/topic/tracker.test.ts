import { describe, it, expect } from "vitest";
import type { ChatMessage } from "@mindcloud/shared";
import {
  TopicTracker,
  MIN_SEGMENT_MESSAGES,
  type PendingTopicJudge,
} from "../../src/memory/topic/tracker.js";
import { JUDGE_ROUND_INTERVAL } from "../../src/memory/topic/types.js";

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

describe("TopicTracker LLM 裁判（方案 C）", () => {
  // 阈值/时间窗拉大：让规则沉默，裁判独占触发权
  const judgeConfig = { enabled: true, windowMinutes: 30, messageThreshold: 100 };

  function fixedMsg(id: string, role: ChatMessage["role"], text: string): ChatMessage {
    return { id, role, content: [{ type: "text", text }], createdAt: at(0) };
  }

  function playRounds(
    tracker: TopicTracker,
    count: number,
    opts: { withTools?: boolean; startIndex?: number } = {},
  ): { judge: PendingTopicJudge | null } {
    let judge: PendingTopicJudge | null = null;
    const start = opts.startIndex ?? 1;
    for (let i = start; i < start + count; i++) {
      tracker.onUserMessage(fixedMsg(`u${i}`, "user", `问题${i}`), "s1");
      const appended = [fixedMsg(`a${i}`, "assistant", `回答${i}`)];
      if (opts.withTools) {
        appended.push(fixedMsg(`tool${i}`, "tool", `工具结果${i}`));
      }
      tracker.onTurnAppended(appended, "s1");
      judge = tracker.peekPendingJudge();
    }
    return { judge };
  }

  it("每 6 轮触发一次判决；tool 消息不计数（5 轮 + 一堆 tool 不触发）", () => {
    const tracker = new TopicTracker(judgeConfig);

    const five = playRounds(tracker, 5, { withTools: true });
    expect(five.judge).toBeNull();

    const six = playRounds(tracker, 1, { withTools: true, startIndex: 6 });
    expect(six.judge).not.toBeNull();
    expect(six.judge!.baseMessageId).toBe("u6");
    // 判决窗口 = 最近 6 轮（含 tool 混入），锚点 = 话题第一条
    expect(six.judge!.anchor.id).toBe("u1");
    expect(six.judge!.recentMessages.map((m) => m.id)).toContain("u1");
    expect(six.judge!.recentMessages.map((m) => m.id)).toContain("a6");
  });

  it("判 NEW_TOPIC：切点在判决依据用户消息之前，判决期间新消息开新话题", () => {
    const tracker = new TopicTracker(judgeConfig);
    const { judge } = playRounds(tracker, 6);
    expect(judge).not.toBeNull();

    // 判决期间新的一轮已到（判完时当前话题已有更多消息）
    tracker.onUserMessage(fixedMsg("u7", "user", "问题7"), "s1");
    tracker.onTurnAppended([fixedMsg("a7", "assistant", "回答7")], "s1");

    const closed = tracker.resolvePendingJudge(judge!.id, "new_topic");
    expect(closed).not.toBeNull();
    // 旧段 = u6 之前（u1..u5 + a1..a5），不含判决依据的 u6 与之后的新消息
    expect(closed!.messages.map((m) => m.id)).toEqual([
      "u1", "a1", "u2", "a2", "u3", "a3", "u4", "a4", "u5", "a5",
    ]);
    expect(closed!.archiveOnly).toBe(false);
    // 新话题从判决依据消息开始：u6 + 其后所有内容（含判决期间新到的 u7/a7）
    expect(tracker.openTopic!.messageIds).toEqual(["u6", "a6", "u7", "a7"]);
  });

  it("判 SAME：无事发生，轮数重新累计", () => {
    const tracker = new TopicTracker(judgeConfig);
    const first = playRounds(tracker, 6);
    expect(first.judge).not.toBeNull();

    expect(tracker.resolvePendingJudge(first.judge!.id, "same")).toBeNull();
    expect(tracker.openTopic!.messageIds).toHaveLength(12);

    // SAME 后重新攒 6 轮才再判：5 轮不触发、第 6 轮触发
    const nextFive = playRounds(tracker, 5, { startIndex: 7 });
    expect(nextFive.judge).toBeNull();
    const nextSix = playRounds(tracker, 1, { startIndex: 12 });
    expect(nextSix.judge).not.toBeNull();
    expect(nextSix.judge!.baseMessageId).toBe("u12");
  });

  it("裁判与规则同跑：规则先切段，裁判判决作废——段只关一次", () => {
    const tracker = new TopicTracker(judgeConfig);
    const { judge } = playRounds(tracker, 6);
    expect(judge).not.toBeNull();

    // 判决在途时用户显式切换话题：规则直接关闭整段
    const ruleClosed = tracker.onUserMessage(fixedMsg("u7", "user", "换个话题"), "s1");
    expect(ruleClosed).not.toBeNull();
    expect(ruleClosed!.messages).toHaveLength(12);

    // 裁判回来判 NEW_TOPIC：已作废，不重复切段
    expect(tracker.peekPendingJudge()).toBeNull();
    expect(tracker.resolvePendingJudge(judge!.id, "new_topic")).toBeNull();
  });

  it("轮数配置常量与定案一致（6 轮）", () => {
    expect(JUDGE_ROUND_INTERVAL).toBe(6);
  });
});
