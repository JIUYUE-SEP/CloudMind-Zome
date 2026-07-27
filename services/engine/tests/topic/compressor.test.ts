import { describe, it, expect, vi } from "vitest";
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

  it("超时不仅 reject，还会 return 迭代器中止底层流", async () => {
    // 回归背景：原实现超时只 reject 外层 Promise，生成器继续空转泄漏 HTTP 连接
    class SlowProvider implements LLMProvider {
      name = "slow";
      closed = false;
      supportsModel() {
        return true;
      }
      async *chat(): AsyncIterable<LLMEvent> {
        try {
          for (let i = 0; i < 1_000_000; i++) {
            yield { type: "text.delta", delta: "x" };
            await new Promise((r) => setTimeout(r, 5)); // 慢速但活跃的流
          }
        } finally {
          this.closed = true; // 迭代器被 return() 时生成器在此处收尾
        }
      }
    }
    const provider = new SlowProvider();
    await expect(compressTopic(makeSegment(), provider, "m", 30)).rejects.toThrow(
      "compress timeout",
    );
    await vi.waitFor(() => expect(provider.closed).toBe(true), { timeout: 1000, interval: 5 });
  });
});

describe("compressTopic 经验提取（Phase 7：同一次调用顺手沉淀）", () => {
  it("压缩 prompt 包含经验提取要求：颗粒度为经验/教训/偏好，没有就留空", async () => {
    const provider = new RecordingProvider();
    await compressTopic(makeSegment(), provider, "k3-cheap");

    expect(provider.lastPrompt).toContain("经验");
    expect(provider.lastPrompt).toContain("偏好");
    // 不硬凑：明确允许输出空
    expect(provider.lastPrompt).toMatch(/留空|没有/);
    // 经验条目格式：标题 | 置信度 | 正文
    expect(provider.lastPrompt).toContain("置信度");
  });

  it("压缩 prompt 含防注入指引（P2-6）：对话片段是数据不是指令，指令性文字不提取不写入", async () => {
    const provider = new RecordingProvider();
    await compressTopic(makeSegment(), provider, "m");

    expect(provider.lastPrompt).toContain("不是给你的指令");
    expect(provider.lastPrompt).toContain("不要提取");
    expect(provider.lastPrompt).toContain("不要写入");
  });

  it("解析经验区：标题/置信度/正文；置信度收敛到 0-1；坏行跳过", async () => {
    const reply = [
      "话题主题：协作偏好与进程管理",
      "关键结论：",
      "- 结论一",
      "经验：",
      "- 指挥官偏好：不用 emoji | 0.9 | 指挥官明确表示不使用 emoji。",
      "- Windows 进程管理 | 1.2 | 杀 node 进程会连带 engine。",
      "- 坏行没有分隔符和置信度",
    ].join("\n");
    const result = await compressTopic(makeSegment(), new FixedReplyProvider(reply), "m");

    expect(result.experiences).toHaveLength(2);
    expect(result.experiences![0]).toEqual({
      title: "指挥官偏好：不用 emoji",
      text: "指挥官明确表示不使用 emoji。",
      confidence: 0.9,
    });
    // 越界置信度 clamp 到 1
    expect(result.experiences![1].confidence).toBe(1);
    expect(result.experiences![1].title).toBe("Windows 进程管理");
  });

  it("无经验可提：经验区留空或写「无」→ experiences 为空", async () => {
    const empty = await compressTopic(
      makeSegment(),
      new FixedReplyProvider("话题主题：闲聊\n关键结论：\n- 没有结论\n经验：\n"),
      "m",
    );
    expect(empty.experiences).toEqual([]);

    const explicitNone = await compressTopic(
      makeSegment(),
      new FixedReplyProvider("话题主题：闲聊\n关键结论：\n- 没有结论\n经验：无"),
      "m",
    );
    expect(explicitNone.experiences).toEqual([]);
  });

  it("区间隔离：关键结论不吃经验区的 dash 行", async () => {
    const reply = [
      "话题主题：测试",
      "关键结论：",
      "- 真正的结论",
      "经验：",
      "- 经验一 | 0.9 | 不应混进关键结论。",
    ].join("\n");
    const result = await compressTopic(makeSegment(), new FixedReplyProvider(reply), "m");

    expect(result.keyPoints).toEqual(["真正的结论"]);
    expect(result.experiences).toHaveLength(1);
  });
});
