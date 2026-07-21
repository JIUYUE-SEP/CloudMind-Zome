import { describe, it, expect } from "vitest";
import { useGroupChatStream } from "@/composables/useGroupChatStream";

describe("useGroupChatStream", () => {
  it("两个 Agent 的并发流式增量进各自气泡，互不交错", () => {
    const { messages, handlers } = useGroupChatStream();

    handlers.onTextDelta("你", "a1");
    handlers.onTextDelta("我", "a2");
    handlers.onTextDelta("好", "a1");
    handlers.onTextDelta("们", "a2");

    expect(messages.value).toHaveLength(2);
    const [m1, m2] = messages.value;
    expect(m1!.agentId).toBe("a1");
    expect(m1!.text).toBe("你好");
    expect(m2!.agentId).toBe("a2");
    expect(m2!.text).toBe("我们");
  });

  it("thinking.delta 也会建立气泡并累积思考内容", () => {
    const { messages, handlers } = useGroupChatStream();
    handlers.onThinkingDelta("想一", "a1");
    handlers.onThinkingDelta("想二", "a1");
    handlers.onTextDelta("答", "a1");

    expect(messages.value).toHaveLength(1);
    expect(messages.value[0]!.thinking).toBe("想一想二");
    expect(messages.value[0]!.text).toBe("答");
  });

  it("tool.call 路由到对应 Agent 的气泡", () => {
    const { messages, handlers } = useGroupChatStream();
    handlers.onTextDelta("查一下", "a1");
    handlers.onTextDelta("稍等", "a2");
    handlers.onToolCall({ toolCallId: "t1", name: "search", arguments: {}, agentId: "a2" });

    expect(messages.value[0]!.toolCalls).toHaveLength(0);
    expect(messages.value[1]!.toolCalls).toHaveLength(1);
    expect(messages.value[1]!.toolCalls[0]!.toolCallId).toBe("t1");
  });

  it("turn.end 只关闭对应 Agent 的槽，同一 turn 的多步进同一气泡", () => {
    const { messages, isStreaming, handlers } = useGroupChatStream();
    handlers.onTextDelta("A", "a1");
    handlers.onTextDelta("B", "a2");
    expect(isStreaming.value).toBe(true);

    // a1 工具调用后继续输出：仍进 a1 的同一气泡，不开新气泡
    handlers.onToolCall({ toolCallId: "t1", name: "search", arguments: {}, agentId: "a1" });
    handlers.onTextDelta("继续", "a1");
    expect(messages.value).toHaveLength(2);
    expect(messages.value[0]!.text).toBe("A继续");
    expect(messages.value[0]!.toolCalls).toHaveLength(1);

    handlers.onTurnEnd("a1");
    expect(messages.value[0]!.isStreaming).toBe(false);
    expect(messages.value[1]!.isStreaming).toBe(true);
    expect(isStreaming.value).toBe(true);

    // a1 下一轮的发言开新气泡
    handlers.onTextDelta("A2", "a1");
    expect(messages.value).toHaveLength(3);
    expect(messages.value[2]!.text).toBe("A2");

    handlers.onTurnEnd("a2");
    handlers.onTurnEnd("a1");
    expect(isStreaming.value).toBe(false);
  });

  it("onError 关闭所有槽并追加错误气泡", () => {
    const { messages, isStreaming, handlers } = useGroupChatStream();
    handlers.onTextDelta("A", "a1");
    handlers.onTextDelta("B", "a2");

    handlers.onError("boom");
    expect(isStreaming.value).toBe(false);
    expect(messages.value[0]!.isStreaming).toBe(false);
    expect(messages.value[1]!.isStreaming).toBe(false);
    expect(messages.value[2]!.text).toBe("Error: boom");
  });

  it("resetStreamState 关闭所有槽", () => {
    const { messages, isStreaming, handlers, resetStreamState } = useGroupChatStream();
    handlers.onTextDelta("A", "a1");
    resetStreamState();
    expect(isStreaming.value).toBe(false);
    expect(messages.value[0]!.isStreaming).toBe(false);
  });

  it("审批请求更新工具状态并追加审批卡片", () => {
    const { messages, handlers } = useGroupChatStream();
    handlers.onToolCall({ toolCallId: "t1", name: "run_command", arguments: {}, agentId: "a1" });
    handlers.onApprovalRequest({
      approvalId: "ap1",
      toolCallId: "t1",
      toolName: "run_command",
      arguments: {},
      agentId: "a1",
    });

    const approvalMsg = messages.value.find((m) => m.approval);
    expect(approvalMsg?.approval?.status).toBe("pending");
    expect(approvalMsg?.approval?.agentId).toBe("a1");
    expect(messages.value[0]!.toolCalls[0]!.status).toBe("awaiting-approval");
  });

  it("pushUserMessage 上屏并锁定输入", () => {
    const { messages, isStreaming, pushUserMessage } = useGroupChatStream();
    pushUserMessage("大家好");
    expect(isStreaming.value).toBe(true);
    expect(messages.value[0]!.role).toBe("user");
    expect(messages.value[0]!.text).toBe("大家好");
  });
});
