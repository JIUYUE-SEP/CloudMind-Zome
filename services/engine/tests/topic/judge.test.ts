import { describe, it, expect, vi, afterEach } from "vitest";
import type { ChatMessage } from "@mindcloud/shared";
import type { LLMChatParams, LLMEvent, LLMProvider } from "../../src/provider/types.js";
import { judgeTopicBoundary, reviewTopicSegments } from "../../src/memory/topic/judge.js";
import type { TopicSegment } from "../../src/memory/topic/types.js";
import { logger } from "../../src/logger.js";

function promptOf(params: LLMChatParams): string {
  return params.messages
    .map((m) => m.content.filter((c) => c.type === "text").map((c) => c.text).join(""))
    .join("\n");
}

class FixedReplyProvider implements LLMProvider {
  name = "fixed";
  lastPrompt = "";
  constructor(
    private reply: string,
    private failOnPrompt?: string,
    private hang = false,
  ) {}
  supportsModel() {
    return true;
  }
  async *chat(params: LLMChatParams): AsyncIterable<LLMEvent> {
    this.lastPrompt = promptOf(params);
    if (this.failOnPrompt && this.lastPrompt.includes(this.failOnPrompt)) {
      throw new Error("judge down");
    }
    if (this.hang) {
      // 不产 step.end：由调用方超时终止生成器
      await new Promise(() => {});
      return;
    }
    yield { type: "text.delta", delta: this.reply };
    yield { type: "step.end" };
  }
}

function msg(id: string, role: "user" | "assistant", text: string): ChatMessage {
  return { id, role, content: [{ type: "text", text }], createdAt: "2026-08-07T00:00:00.000Z" };
}

function judgeInput(): { anchor: ChatMessage; recentMessages: ChatMessage[] } {
  return {
    anchor: msg("u1", "user", "先聊修 bug"),
    recentMessages: [
      msg("u1", "user", "先聊修 bug"),
      msg("a1", "assistant", "看看报错"),
      msg("u6", "user", "晚上吃什么"),
      msg("a6", "assistant", "推荐火锅"),
    ],
  };
}

function makeSegment(messageCount: number): TopicSegment {
  const messages: ChatMessage[] = [];
  for (let i = 1; i <= messageCount; i++) {
    messages.push(msg(`m${i}`, i % 2 === 1 ? "user" : "assistant", `内容 ${i}`));
  }
  return {
    topicId: "tp_test_review",
    messages,
    sourceId: "s1",
    startedAt: messages[0]!.createdAt,
    endedAt: messages[messages.length - 1]!.createdAt,
  };
}

describe("judgeTopicBoundary（话题边界 LLM 裁判）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("NEW_TOPIC：输出判定为切新话题", async () => {
    const provider = new FixedReplyProvider("NEW_TOPIC");
    expect(await judgeTopicBoundary(provider, "judge-1", judgeInput())).toBe("new_topic");
    // prompt 带防注入声明（P2-6，对齐 compressor.ts）
    expect(provider.lastPrompt).toContain("防注入（P2-6）");
    expect(provider.lastPrompt).toContain("话题锚点");
  });

  it("SAME：输出判定为同话题", async () => {
    const provider = new FixedReplyProvider("SAME");
    expect(await judgeTopicBoundary(provider, "judge-1", judgeInput())).toBe("same");
  });

  it("乱输出：按 SAME 处理并 warn", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const provider = new FixedReplyProvider("今天天气不错，随便聊聊");
    expect(await judgeTopicBoundary(provider, "judge-1", judgeInput())).toBe("same");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("无法解析"));
  });

  it("调用失败：按 SAME 处理并 warn，不抛出", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const provider = new FixedReplyProvider("", "话题边界裁判");
    expect(await judgeTopicBoundary(provider, "judge-1", judgeInput())).toBe("same");
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining("调用失败"),
    );
  });

  it("超时：按 SAME 处理并 warn，不抛出", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const provider = new FixedReplyProvider("NEW_TOPIC", undefined, true);
    expect(await judgeTopicBoundary(provider, "judge-1", judgeInput(), 20)).toBe("same");
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining("调用失败"),
    );
  });
});

describe("reviewTopicSegments（压缩前复核）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("MULTI_TOPIC：拆成两个子段，msgIds 无交叉、各自独立 topicId", async () => {
    const provider = new FixedReplyProvider("MULTI_TOPIC 3");
    const segments = await reviewTopicSegments(makeSegment(6), provider, "judge-1");
    expect(segments).toHaveLength(2);
    expect(segments[0]!.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(segments[1]!.messages.map((m) => m.id)).toEqual(["m4", "m5", "m6"]);
    expect(segments[0]!.topicId).toBe("tp_test_review_1");
    expect(segments[1]!.topicId).toBe("tp_test_review_2");
    expect(segments[0]!.archiveOnly).toBe(false);
    expect(segments[1]!.archiveOnly).toBe(false);
    expect(provider.lastPrompt).toContain("防注入（P2-6）");
  });

  it("SINGLE_TOPIC：原段照旧返回", async () => {
    const provider = new FixedReplyProvider("SINGLE_TOPIC");
    const segment = makeSegment(4);
    const segments = await reviewTopicSegments(segment, provider, "judge-1");
    expect(segments).toEqual([segment]);
  });

  it("调用失败：整段单话题压缩（回退现状）并 warn", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const provider = new FixedReplyProvider("", "复核裁判");
    const segment = makeSegment(4);
    const segments = await reviewTopicSegments(segment, provider, "judge-1");
    expect(segments).toEqual([segment]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining("复核裁判调用失败"),
    );
  });

  it("切点非法（0 / 超界）：整段单话题压缩并 warn", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const segment = makeSegment(4);
    expect(
      await reviewTopicSegments(segment, new FixedReplyProvider("MULTI_TOPIC 0"), "judge-1"),
    ).toEqual([segment]);
    expect(
      await reviewTopicSegments(segment, new FixedReplyProvider("MULTI_TOPIC 99"), "judge-1"),
    ).toEqual([segment]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("切点非法"));
  });

  it("乱输出：整段单话题压缩并 warn", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const segment = makeSegment(4);
    expect(
      await reviewTopicSegments(segment, new FixedReplyProvider("随便说说"), "judge-1"),
    ).toEqual([segment]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("无法解析"));
  });
});
