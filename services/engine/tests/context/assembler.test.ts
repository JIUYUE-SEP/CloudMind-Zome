import { describe, it, expect } from "vitest";
import type { ChatMessage } from "@mindcloud/shared";
import { createLayers } from "../../src/context/layers.js";
import type { SemanticMemory, TopicSummary } from "../../src/context/layers.js";
import { assembleMessages } from "../../src/context/assembler.js";

const NOW = Date.parse("2026-07-22T12:00:00.000Z");

function userMsg(id: string, text: string, createdAt: string): ChatMessage {
  return { id, role: "user", content: [{ type: "text", text }], createdAt };
}

function history(n: number): ChatMessage[] {
  return Array.from({ length: n }, (_, i) =>
    userMsg(`h${i}`, `history ${i}`, "2026-07-17T00:00:00Z"),
  );
}

function mem(content: string, overrides: Partial<SemanticMemory> = {}): SemanticMemory {
  return { id: content, content, score: 0.9, createdAt: "2026-07-10T00:00:00Z", ...overrides };
}

function topic(label: string, overrides: Partial<TopicSummary> = {}): TopicSummary {
  return {
    id: `tp_${label}`,
    label,
    text: `${label}的摘要正文`,
    createdAt: "2026-07-08T00:00:00Z",
    ...overrides,
  };
}

function textOf(m: ChatMessage): string {
  return m.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}

describe("assembleMessages 最终设计：固定前缀 + 伪装历史", () => {
  it("L1/L2 相邻置于头部（system prompt 固定前缀），L3 历史尾随", () => {
    const layers = createLayers({
      l1: "人格内容",
      l2: "@提醒",
      l3: history(2),
    });
    const messages = assembleMessages(layers, { now: NOW });

    expect(messages[0].role).toBe("system");
    expect(textOf(messages[0])).toContain("人格内容");
    expect(messages[1].role).toBe("system");
    expect(textOf(messages[1])).toContain("@提醒");
    expect(messages.slice(2)).toEqual(layers.l3);
  });

  it("L4/L5 伪装成 user 历史消息，不再是 system 元信息", () => {
    const layers = createLayers({
      l3: history(1),
      l4: [mem("检索片段")],
      l5: [topic("旧话题")],
    });
    const messages = assembleMessages(layers, { now: NOW });

    // 没有任何 system 元信息消息（无 L1/L2 时 system 数量为 0）
    expect(messages.every((m) => m.role !== "system")).toBe(true);
    const all = messages.map(textOf).join("\n");
    expect(all).not.toContain("以下是过去话题的摘要");
    expect(all).not.toContain("相关片段");
    // 第三人称自然化文本
    expect(all).toContain("用户之前提到过");
    expect(all).toContain("用户之前聊过");
  });

  it("按真实时间排序：记忆穿插在真实历史中", () => {
    const layers = createLayers({
      l3: [
        userMsg("h-old", "较早的历史", "2026-07-05T00:00:00Z"),
        userMsg("h-new", "较晚的历史", "2026-07-20T00:00:00Z"),
      ],
      l4: [mem("中间的记忆", { createdAt: "2026-07-10T00:00:00Z" })],
      l5: [topic("最旧的话题", { createdAt: "2026-07-01T00:00:00Z" })],
    });
    const messages = assembleMessages(layers, { now: NOW });
    const ids = messages.map((m) => m.id);
    // topic(07-01) → h-old(07-05) → mem(07-10) → h-new(07-20)
    expect(ids).toEqual(["topic-tp_最旧的话题", "h-old", "mem-中间的记忆", "h-new"]);
  });

  it("时间戳相等时伪装消息排在真实消息之前（稳定归并）", () => {
    const layers = createLayers({
      l3: [userMsg("h0", "历史", "2026-07-10T00:00:00Z")],
      l4: [mem("记忆", { createdAt: "2026-07-10T00:00:00Z" })],
    });
    const messages = assembleMessages(layers, { now: NOW });
    expect(messages.map((m) => m.id)).toEqual(["mem-记忆", "h0"]);
  });

  it("伪装消息保留原始 createdAt（时间真实）", () => {
    const layers = createLayers({
      l3: [],
      l4: [mem("记忆", { createdAt: "2026-07-10T15:30:00.000Z" })],
    });
    const messages = assembleMessages(layers, { now: NOW });
    expect(messages[0].createdAt).toBe("2026-07-10T15:30:00.000Z");
    expect(textOf(messages[0])).toContain("2026-07-10 15:30");
  });

  it("score ≤ 0.5 的记忆被丢弃，0.5 < score ≤ 0.7 模糊化", () => {
    const layers = createLayers({
      l3: [],
      l4: [mem("丢弃的记忆", { score: 0.4 }), mem("模糊的记忆", { score: 0.6 })],
    });
    const messages = assembleMessages(layers, { now: NOW });
    const all = messages.map(textOf).join("\n");
    expect(all).not.toContain("丢弃的记忆");
    expect(all).toContain("模糊的记忆");
    expect(all).toContain("好像");
  });

  it("检索失败：尾随 system 消息明确告知，不伪装", () => {
    const layers = createLayers({ l1: "人格", l3: history(1) });
    const messages = assembleMessages(layers, { now: NOW, retrievalFailed: true });

    const last = messages.at(-1)!;
    expect(last.role).toBe("system");
    expect(textOf(last)).toContain("记忆检索暂时不可用");
    // 失败提示在对话末尾（当前输入之后），不污染固定前缀
    expect(messages[0].role).toBe("system");
    expect(textOf(messages[0])).toContain("人格");
    expect(messages.at(-2)!.id).toBe("h0");
  });

  it("retrievalFailed 缺省/false 时不追加失败提示", () => {
    const layers = createLayers({ l3: history(1) });
    expect(assembleMessages(layers, { now: NOW })).toHaveLength(1);
    expect(assembleMessages(layers, { now: NOW, retrievalFailed: false })).toHaveLength(1);
  });

  it("L1 为空、可选层缺省时只组装非空层", () => {
    const layers = createLayers({ l3: history(1) });
    const messages = assembleMessages(layers, { now: NOW });
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
  });

  it("空字符串的可选层不产生 system 消息", () => {
    const layers = createLayers({ l1: "  ", l3: history(1) });
    const messages = assembleMessages(layers, { now: NOW });
    expect(messages.every((m) => m.role !== "system")).toBe(true);
  });

  it("不修改传入的 L3 数组（引用不变）", () => {
    const l3 = history(3);
    const layers = createLayers({ l3 });
    const messages = assembleMessages(layers, { now: NOW });
    expect(messages.filter((m) => !m.id.startsWith("mem-") && !m.id.startsWith("topic-"))).toEqual(l3);
    expect(layers.l3).toBe(l3);
  });
});
