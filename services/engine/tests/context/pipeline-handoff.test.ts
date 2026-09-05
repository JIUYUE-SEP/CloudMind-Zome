/**
 * 交接书置顶注入：
 * ① 固定 system 消息置于 L1 之前（真正"置顶"，不被历史顺序淹没）；
 * ② 预算不足降级 L3 时置顶注入仍在且位置不变；
 * ③ 计入固定预算（与 L1 同口径，不参与降级）。
 */
import { describe, it, expect } from "vitest";
import { ContextPipeline } from "../../src/context/pipeline.js";
import type { ChatMessage } from "@cloudmind/shared";

const PINNED = "[交接书] 上下文水位撞顶，本轮任务未完成，换班移交（第 1/3 棒）。\n- 进展X；下一步Y";

function userMessage(text: string, id: string): ChatMessage {
  return {
    id,
    role: "user",
    content: [{ type: "text", text }],
    createdAt: "2024-01-01",
  };
}

describe("交接书置顶注入（pipeline）", () => {
  it("置顶：固定 system 消息在 L1 人格之前（messages[0]）", async () => {
    const pipeline = new ContextPipeline({ maxContextTokens: 80_000 });
    const assembled = await pipeline.assemble({
      agentId: "a1",
      history: [userMessage("hi", "m1")],
      mindContext: "# SOUL\n我是人格",
      sourceId: "s1",
      tools: [],
      handoffPinned: PINNED,
    });
    const first = assembled.messages[0]!;
    expect(first.role).toBe("system");
    expect(first.content).toEqual([{ type: "text", text: PINNED }]);
    expect(assembled.messages[1]!.content.some((c) => c.type === "text" && c.text.includes("# SOUL"))).toBe(true);
  });

  it("预算不足降级 L3 时置顶注入仍在且保持首位", async () => {
    // budget = 90（100 * 0.9）：L1 大 + 多条 L3 必然触发 L3 裁剪，pinned 固定不参与降级
    const pipeline = new ContextPipeline({ maxContextTokens: 100 });
    const history = Array.from({ length: 40 }, (_, i) =>
      userMessage(`消息 ${i} `.repeat(30), `m${i}`),
    );
    const assembled = await pipeline.assemble({
      agentId: "a1",
      history,
      mindContext: "SOUL",
      sourceId: "s1",
      tools: [],
      handoffPinned: PINNED,
    });
    expect(assembled.messages[0]!.content.some((c) => c.type === "text" && c.text === PINNED)).toBe(true);
    expect(assembled.messages.length).toBeGreaterThan(1);
    // L3 确实被裁剪（40 条大消息在 90 token 预算下不可能全保留）
    expect(history.length).toBeGreaterThan(assembled.messages.length);
  });

  it("置顶注入计入固定预算：无 pinned 时历史可多留，有 pinned 时降级更激进", async () => {
    const pipeline = new ContextPipeline({ maxContextTokens: 100 });
    const history = Array.from({ length: 20 }, (_, i) => userMessage(`消息 ${i} `.repeat(40), `m${i}`));
    const without = await pipeline.assemble({
      agentId: "a1",
      history,
      mindContext: "",
      sourceId: "s1",
      tools: [],
    });
    const withPinned = await pipeline.assemble({
      agentId: "a1",
      history,
      mindContext: "",
      sourceId: "s1",
      tools: [],
      handoffPinned: PINNED,
    });
    // 相同预算下，置顶注入占掉预算 → 保留的历史消息数不增（一般更少）
    expect(withPinned.messages.length).toBeLessThanOrEqual(without.messages.length + 1);
    expect(withPinned.messages[0]!.content.some((c) => c.type === "text" && c.text === PINNED)).toBe(true);
  });

  it("handoffPinned 为空字符串（K4）：不注入置顶消息，首条仍是 L1 人格", async () => {
    const pipeline = new ContextPipeline({ maxContextTokens: 80_000 });
    const assembled = await pipeline.assemble({
      agentId: "a1",
      history: [userMessage("hi", "m1")],
      mindContext: "# SOUL\n我是人格",
      sourceId: "s1",
      tools: [],
      handoffPinned: "",
    });
    expect(assembled.messages).toHaveLength(2);
    expect(
      assembled.messages[0]!.content.some((c) => c.type === "text" && c.text.includes("# SOUL")),
    ).toBe(true);
  });
});
