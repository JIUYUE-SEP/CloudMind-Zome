import { describe, it, expect } from "vitest";
import type { ChatMessage } from "@mindcloud/shared";
import { createLayers } from "../../src/context/layers.js";
import { assembleMessages } from "../../src/context/assembler.js";

function history(n: number): ChatMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `h${i}`,
    role: "user" as const,
    content: [{ type: "text" as const, text: `history ${i}` }],
    createdAt: "2026-07-17T00:00:00Z",
  }));
}

describe("assembleMessages", () => {
  it("按 L1 → L1.5 → L5 → L4 → L2 → L3 顺序组装", () => {
    const layers = createLayers({
      l1: "人格内容",
      l1_5: "群聊指令",
      l2: "@提醒",
      l3: history(2),
      l4: ["检索片段"],
      l5: ["话题摘要"],
    });
    const messages = assembleMessages(layers);

    const systems = messages.filter((m) => m.role === "system");
    expect(systems).toHaveLength(5);
    const texts = systems.map((m) => (m.content[0] as { type: "text"; text: string }).text);
    expect(texts[0]).toContain("人格内容");
    expect(texts[1]).toContain("群聊指令");
    expect(texts[2]).toContain("话题摘要");
    expect(texts[3]).toContain("检索片段");
    expect(texts[4]).toContain("@提醒");

    // L3 历史原样跟在 system 之后
    expect(messages.slice(5)).toEqual(layers.l3);
  });

  it("L1 为空、可选层缺省时只组装非空层", () => {
    const layers = createLayers({ l3: history(1) });
    const messages = assembleMessages(layers);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
  });

  it("L5/L4 多条时合并为一个 system 消息", () => {
    const layers = createLayers({
      l3: history(1),
      l5: ["摘要A", "摘要B"],
      l4: ["片段1", "片段2", "片段3"],
    });
    const messages = assembleMessages(layers);
    const systems = messages.filter((m) => m.role === "system");
    expect(systems).toHaveLength(2);
    const l5Text = (systems[0].content[0] as { type: "text"; text: string }).text;
    const l4Text = (systems[1].content[0] as { type: "text"; text: string }).text;
    expect(l5Text).toContain("摘要A");
    expect(l5Text).toContain("摘要B");
    expect(l4Text).toContain("片段1");
    expect(l4Text).toContain("片段3");
  });

  it("空字符串的可选层不产生 system 消息", () => {
    const layers = createLayers({ l1: "  ", l1_5: "", l3: history(1) });
    const messages = assembleMessages(layers);
    expect(messages.every((m) => m.role !== "system")).toBe(true);
  });

  it("不修改传入的 L3 数组（引用不变）", () => {
    const l3 = history(3);
    const layers = createLayers({ l3 });
    const messages = assembleMessages(layers);
    expect(messages.filter((m) => m.role !== "system")).toEqual(l3);
    expect(layers.l3).toBe(l3);
  });
});
