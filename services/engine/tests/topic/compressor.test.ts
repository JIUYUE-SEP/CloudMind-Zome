import { describe, it, expect } from "vitest";
import type { ChatMessage } from "@mindcloud/shared";
import type { LLMProvider, LLMChatParams, LLMEvent } from "../../src/provider/types.js";
import { compressTopic } from "../../src/memory/topic/compressor.js";
import type { TopicSegment } from "../../src/memory/topic/types.js";

class FixedReplyProvider implements LLMProvider {
  name = "fixed";
  constructor(private reply: string) {}
  supportsModel() {
    return true;
  }
  async *chat(): AsyncIterable<LLMEvent> {
    yield { type: "text.delta", delta: this.reply };
    yield { type: "step.end" };
  }
}

class RecordingProvider implements LLMProvider {
  name = "recording";
  lastModel = "";
  lastPrompt = "";
  supportsModel() {
    return true;
  }
  async *chat(params: LLMChatParams): AsyncIterable<LLMEvent> {
    this.lastModel = params.model;
    this.lastPrompt = params.messages.map((m) =>
      m.content.filter((c) => c.type === "text").map((c) => c.text).join(""),
    ).join("\n");
    yield { type: "text.delta", delta: "话题主题：测试\n关键结论：\n- 结论一" };
    yield { type: "step.end" };
  }
}

class FailingProvider implements LLMProvider {
  name = "failing";
  supportsModel() {
    return true;
  }
  async *chat(): AsyncIterable<LLMEvent> {
    throw new Error("provider down");
  }
}

function makeSegment(): TopicSegment {
  const messages: ChatMessage[] = Array.from({ length: 5 }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: [{ type: "text" as const, text: `内容${i}` }],
    createdAt: "2026-07-21T10:00:00.000Z",
  }));
  return {
    topicId: "tp_test_1",
    messages,
    sourceId: "s1",
    sourceName: "测试会话",
    startedAt: messages[0]!.createdAt,
    endedAt: messages[4]!.createdAt,
  };
}

describe("compressTopic", () => {
  it("解析标准格式：主题与关键结论", async () => {
    const provider = new FixedReplyProvider("话题主题：前端状态管理选型\n关键结论：\n- 决定用 Zustand\n- 状态持久化用 localStorage");
    const result = await compressTopic(makeSegment(), provider, "compress-model");

    expect(result.label).toBe("前端状态管理选型");
    expect(result.keyPoints).toEqual(["决定用 Zustand", "状态持久化用 localStorage"]);
    expect(result.msgIds).toEqual(["m0", "m1", "m2", "m3", "m4"]);
    expect(result.msgCount).toBe(5);
    expect(result.importance).toBe("normal");
    expect(result.sourceId).toBe("s1");
    expect(result.compressedAt).toBeTruthy();
  });

  it("压缩 prompt 携带消息内容与模型名", async () => {
    const provider = new RecordingProvider();
    await compressTopic(makeSegment(), provider, "k3-cheap");

    expect(provider.lastModel).toBe("k3-cheap");
    expect(provider.lastPrompt).toContain("内容0");
    expect(provider.lastPrompt).toContain("话题主题");
  });

  it("乱格式输出走兜底：未命名话题 + 原文摘要", async () => {
    const provider = new FixedReplyProvider("我完全没按格式回答");
    const result = await compressTopic(makeSegment(), provider, "m");

    expect(result.label).toBe("（未命名话题）");
    expect(result.summary).toBe("我完全没按格式回答");
    expect(result.keyPoints.length).toBeGreaterThan(0);
  });

  it("压缩失败直接抛错（不 fallback 不吞）", async () => {
    await expect(compressTopic(makeSegment(), new FailingProvider(), "m")).rejects.toThrow(
      "provider down",
    );
  });
});
