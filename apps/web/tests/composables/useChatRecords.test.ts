import { describe, it, expect } from "vitest";
import { setToolCallStatus, type DisplayMessage } from "@/composables/useChatRecords";

function makeMessages(): DisplayMessage[] {
  return [
    {
      id: "m1",
      role: "assistant",
      text: "a",
      thinking: "",
      toolCalls: [{ toolCallId: "t1", name: "search", arguments: {} }],
      isStreaming: false,
    },
    {
      id: "m2",
      role: "assistant",
      text: "b",
      thinking: "",
      toolCalls: [{ toolCallId: "t2", name: "bash", arguments: {} }],
      isStreaming: true,
    },
  ];
}

describe("setToolCallStatus", () => {
  it("按 toolCallId 更新匹配工具调用的状态", () => {
    const messages = makeMessages();
    setToolCallStatus(messages, "t1", "awaiting-approval");
    expect(messages[0]!.toolCalls[0]!.status).toBe("awaiting-approval");
    expect(messages[1]!.toolCalls[0]!.status).toBeUndefined();
  });

  it("从尾部向前找，命中最近的消息", () => {
    const messages = makeMessages();
    messages[1]!.toolCalls.push({ toolCallId: "t1", name: "search", arguments: {} });
    setToolCallStatus(messages, "t1", "done");
    expect(messages[1]!.toolCalls[1]!.status).toBe("done");
    expect(messages[0]!.toolCalls[0]!.status).toBeUndefined();
  });

  it("找不到 toolCallId 时静默跳过", () => {
    const messages = makeMessages();
    expect(() => setToolCallStatus(messages, "nope", "done")).not.toThrow();
  });
});
