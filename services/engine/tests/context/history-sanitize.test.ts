import { logger } from "../../src/logger.js";
import { describe, it, expect, vi } from "vitest";
import type { ChatMessage } from "@mindcloud/shared";
import { stripUnansweredToolCalls } from "../../src/context/history-sanitize.js";

function assistant(id: string, text: string, toolCallIds?: string[]): ChatMessage {
  return {
    id,
    role: "assistant",
    content: [{ type: "text", text }],
    toolCalls: toolCallIds?.map((toolCallId) => ({ toolCallId, name: "dummy", arguments: {} })),
    createdAt: "2024-01-01",
  };
}

function tool(toolCallId: string): ChatMessage {
  return {
    id: `tool_${toolCallId}`,
    role: "tool",
    content: [{ type: "text", text: "result" }],
    toolCallId,
    createdAt: "2024-01-01",
  };
}

function user(text: string): ChatMessage {
  return { id: `u_${text}`, role: "user", content: [{ type: "text", text }], createdAt: "2024-01-01" };
}

describe("stripUnansweredToolCalls（半个 turn 清洗，P1-6）", () => {
  it("完整消息对原样返回（同引用，无拷贝）", () => {
    const history = [user("hi"), assistant("a1", "用工具", ["tc1"]), tool("tc1"), assistant("a2", "done")];
    expect(stripUnansweredToolCalls(history)).toBe(history);
  });

  it("半个 turn：assistant 的 toolCalls 全无应答 → 摘除 toolCalls 字段，正文保留", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const history = [user("hi"), assistant("a1", "说到一半的回复", ["tc1", "tc2"])];
    const out = stripUnansweredToolCalls(history);
    expect(out).toHaveLength(2);
    expect(out[1]!.toolCalls).toBeUndefined();
    expect(out[1]!.content).toEqual([{ type: "text", text: "说到一半的回复" }]);
    // 原消息不被原地修改
    expect(history[1]!.toolCalls).toHaveLength(2);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("部分应答：摘除无应答的 toolCallId，有应答的与其 tool 消息保留", () => {
    const history = [user("hi"), assistant("a1", "两个调用只落了一个结果", ["tc1", "tc2"]), tool("tc1")];
    const out = stripUnansweredToolCalls(history);
    expect(out).toHaveLength(3);
    expect(out[1]!.toolCalls?.map((tc) => tc.toolCallId)).toEqual(["tc1"]);
    expect(out[2]!.role).toBe("tool");
  });

  it("孤儿 tool 消息（窗口切断前置 assistant toolCalls）被丢弃", () => {
    const history = [tool("tc-ghost"), user("hi")];
    const out = stripUnansweredToolCalls(history);
    expect(out.map((m) => m.role)).toEqual(["user"]);
  });

  it("历史不含 tool 调用时原样返回", () => {
    const history = [user("a"), assistant("a1", "普通回复")];
    expect(stripUnansweredToolCalls(history)).toBe(history);
  });
});
