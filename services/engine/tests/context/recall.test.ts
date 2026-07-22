import { describe, it, expect } from "vitest";
import type { SemanticMemory, TopicSummary } from "../../src/context/layers.js";
import {
  classifyScore,
  relativeTime,
  formatMemoryTime,
  summarizeContent,
  memoryToMessage,
  topicToMessage,
  retrievalFailedMessage,
  CONFIDENCE_HIGH,
  CONFIDENCE_DROP,
  MAX_MEMORY_CHARS,
} from "../../src/context/recall.js";

const NOW = Date.parse("2026-07-22T12:00:00.000Z");
const DAY = 86_400_000;

function mem(overrides: Partial<SemanticMemory> = {}): SemanticMemory {
  return {
    id: "m1",
    content: "Python 装饰器的用法",
    score: 0.9,
    createdAt: "2026-07-10T15:30:00.000Z",
    ...overrides,
  };
}

function topic(overrides: Partial<TopicSummary> = {}): TopicSummary {
  return {
    id: "tp_1",
    label: "部署方案",
    text: "讨论了生产环境的部署步骤。\n关键结论：\n- 先灰度后全量",
    createdAt: "2026-07-08T21:00:00.000Z",
    ...overrides,
  };
}

describe("classifyScore 置信度分档", () => {
  it("score > 0.7 正常注入", () => {
    expect(classifyScore(0.9)).toBe("high");
    expect(classifyScore(CONFIDENCE_HIGH + 0.01)).toBe("high");
  });

  it("0.5 < score ≤ 0.7 模糊化注入", () => {
    expect(classifyScore(0.7)).toBe("fuzzy");
    expect(classifyScore(CONFIDENCE_HIGH)).toBe("fuzzy");
    expect(classifyScore(0.51)).toBe("fuzzy");
  });

  it("score ≤ 0.5 丢弃", () => {
    expect(classifyScore(0.5)).toBe("drop");
    expect(classifyScore(CONFIDENCE_DROP)).toBe("drop");
    expect(classifyScore(0.1)).toBe("drop");
  });
});

describe("relativeTime 相对时间", () => {
  it("一分钟内：刚刚", () => {
    expect(relativeTime(new Date(NOW - 30_000).toISOString(), NOW)).toBe("刚刚");
  });

  it("分钟/小时/天/月/年分档", () => {
    expect(relativeTime(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe("5分钟前");
    expect(relativeTime(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)).toBe("3小时前");
    expect(relativeTime(new Date(NOW - 12 * DAY).toISOString(), NOW)).toBe("12天前");
    expect(relativeTime(new Date(NOW - 60 * DAY).toISOString(), NOW)).toBe("2个月前");
    expect(relativeTime(new Date(NOW - 400 * DAY).toISOString(), NOW)).toBe("1年前");
  });
});

describe("formatMemoryTime 时间戳渲染", () => {
  it("绝对时间 + 相对时间，心智可算时间差", () => {
    expect(formatMemoryTime("2026-07-10T15:30:00.000Z", NOW)).toBe("2026-07-10 15:30 · 11天前");
  });

  it("无法解析的时间原样返回，不崩溃", () => {
    expect(formatMemoryTime("not-a-date", NOW)).toBe("not-a-date");
  });
});

describe("summarizeContent 长度控制", () => {
  it("不超过上限原样返回", () => {
    const text = "x".repeat(MAX_MEMORY_CHARS);
    expect(summarizeContent(text)).toBe(text);
  });

  it("超过 500 字符摘要化：保留首尾、标注中段省略", () => {
    const text = "头".repeat(300) + "中".repeat(400) + "尾".repeat(150);
    const out = summarizeContent(text);
    expect(text.length).toBeGreaterThan(MAX_MEMORY_CHARS);
    expect(out).toContain("省略");
    expect(out.startsWith("头".repeat(300))).toBe(true);
    expect(out.endsWith("尾".repeat(150))).toBe(true);
    expect(out.length).toBeLessThan(text.length);
  });
});

describe("memoryToMessage 语义记忆自然化", () => {
  it("高置信度：第三人称正常注入，伪装成 user 历史消息", () => {
    const msg = memoryToMessage(mem(), NOW)!;
    expect(msg).not.toBeNull();
    expect(msg.role).toBe("user");
    const text = (msg.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("用户之前提到过");
    expect(text).toContain("Python 装饰器的用法");
    // 避免"你/我/我们"亲密错觉：叙述部分第三人称
    expect(text).not.toContain("你");
    expect(text).not.toContain("我们");
  });

  it("保留原始 createdAt：消息时间戳真实，正文带可读时间前缀", () => {
    const msg = memoryToMessage(mem(), NOW)!;
    expect(msg.createdAt).toBe("2026-07-10T15:30:00.000Z");
    const text = (msg.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("2026-07-10 15:30");
    expect(text).toContain("11天前");
  });

  it("低置信度模糊化：好像 + 不保证准确", () => {
    const msg = memoryToMessage(mem({ score: 0.6 }), NOW)!;
    const text = (msg.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("好像");
    expect(text).toContain("模糊");
  });

  it("score ≤ 0.5 直接丢弃（返回 null）", () => {
    expect(memoryToMessage(mem({ score: 0.5 }), NOW)).toBeNull();
    expect(memoryToMessage(mem({ score: 0.2 }), NOW)).toBeNull();
  });

  it("跨场景命中：自然化标注来源（另一个对话）", () => {
    const msg = memoryToMessage(mem({ source: "session_x" }), NOW)!;
    const text = (msg.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("另一个对话");
  });

  it("超长记忆摘要化注入", () => {
    const msg = memoryToMessage(mem({ content: "长".repeat(800) }), NOW)!;
    const text = (msg.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("省略");
    expect(text.length).toBeLessThan(800);
  });
});

describe("topicToMessage 话题摘要自然化", () => {
  it("第三人称 + 保留压缩时间戳", () => {
    const msg = topicToMessage(topic(), NOW);
    expect(msg.role).toBe("user");
    expect(msg.createdAt).toBe("2026-07-08T21:00:00.000Z");
    const text = (msg.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("用户之前聊过");
    expect(text).toContain("部署方案");
    expect(text).toContain("先灰度后全量");
    expect(text).toContain("2026-07-08 21:00");
  });
});

describe("retrievalFailedMessage 检索失败明确告知", () => {
  it("system 消息明确标注记忆检索不可用", () => {
    const msg = retrievalFailedMessage();
    expect(msg.role).toBe("system");
    const text = (msg.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("记忆检索暂时不可用");
  });
});
