import { describe, it, expect } from "vitest";
import type { ChatMessage } from "@cloudmind/shared";
import { createLayers, DOWNGRADE_ORDER } from "../../src/context/layers.js";
import type { SemanticMemory, TopicSummary } from "../../src/context/layers.js";

function msg(id: string): ChatMessage {
  return { id, role: "user", content: [{ type: "text", text: "hi" }], createdAt: "2026-07-17T00:00:00Z" };
}

function mem(content: string): SemanticMemory {
  return { id: content, content, score: 0.9, createdAt: "2026-07-17T00:00:00Z" };
}

function topic(text: string): TopicSummary {
  return { id: `tp_${text}`, label: text, text, createdAt: "2026-07-17T00:00:00Z" };
}

describe("context layers", () => {
  it("createLayers 只传 l3 时其余层给安全默认值", () => {
    const layers = createLayers({ l3: [msg("a")] });
    expect(layers.l1).toBe("");
    // M7：L2 @提及层已删除（死输入清理）——层集合中不再存在 l2
    expect("l2" in layers).toBe(false);
    expect(layers.l4).toEqual([]);
    expect(layers.l5).toEqual([]);
    expect(layers.l6Core).toEqual([]);
    expect(layers.l6Ext).toEqual([]);
    expect(layers.l3).toHaveLength(1);
  });

  it("createLayers 保留传入的全部层内容", () => {
    const layers = createLayers({
      l1: "人格",
      l3: [msg("a")],
      l4: [mem("检索片段")],
      l5: [topic("话题摘要")],
      l6Core: [{ name: "read_file" }],
      l6Ext: [{ name: "mcp_tool" }],
    });
    expect(layers.l1).toBe("人格");
    expect(layers.l4).toEqual([mem("检索片段")]);
    expect(layers.l6Core).toHaveLength(1);
    expect(layers.l6Ext).toHaveLength(1);
  });

  it("降级顺序为 L5 → L4 → L6-ext → L3，且不包含永不压缩层", () => {
    expect(DOWNGRADE_ORDER).toEqual(["l5", "l4", "l6Ext", "l3"]);
    // L1/L6-core 永不出现在降级序列中
    expect(DOWNGRADE_ORDER).not.toContain("l1");
    expect(DOWNGRADE_ORDER).not.toContain("l6Core");
  });
});
