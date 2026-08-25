import { describe, it, expect } from "vitest";
import { setToolCallStatus, setToolCallOutput, useChatRecords, type DisplayMessage } from "@/composables/useChatRecords";
import type { ChatMessageRecord } from "@/composables/useEngineClient";

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

describe("recordsToDisplay", () => {
  function makeRecord(id: string, agentId?: string): ChatMessageRecord {
    return {
      id,
      sessionId: "s1",
      role: agentId ? "assistant" : "user",
      content: [{ type: "text", text: `msg-${id}` }],
      createdAt: "2026-07-21T00:00:00.000Z",
      ...(agentId ? { agentId } : {}),
    };
  }

  it("保留 engine 标注的 agentId 归属", () => {
    const { recordsToDisplay } = useChatRecords();
    const out = recordsToDisplay([makeRecord("m1"), makeRecord("m2", "a1")]);
    expect(out[0]!.agentId).toBeUndefined();
    expect(out[1]!.agentId).toBe("a1");
  });

  it("按消息 id 去重（群聊用户消息在每个成员仓库各存一份）", () => {
    const { recordsToDisplay } = useChatRecords();
    const dup = makeRecord("m1");
    const out = recordsToDisplay([dup, makeRecord("m2", "a1"), { ...dup }, makeRecord("m3", "a2")]);
    expect(out.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
  });

  it("tool 结果记录不进气泡，JSON 载荷回填到对应 toolCall.output（generate_image 出图链路）", () => {
    const { recordsToDisplay } = useChatRecords();
    const imageOutput = { path: "files/images/x.png", persisted: true };
    const records: ChatMessageRecord[] = [
      {
        id: "m1",
        sessionId: "s1",
        role: "assistant",
        content: [{ type: "text", text: "好" }],
        toolCalls: [{ toolCallId: "t1", name: "generate_image", arguments: { prompt: "p" } }],
        createdAt: "2026-08-26T00:00:00.000Z",
      },
      {
        id: "tool_t1",
        sessionId: "s1",
        role: "tool",
        content: [{ type: "text", text: JSON.stringify(imageOutput) }],
        toolCallId: "t1",
        createdAt: "2026-08-26T00:00:01.000Z",
      },
    ];
    const out = recordsToDisplay(records);
    expect(out).toHaveLength(1);
    expect(out[0]!.toolCalls[0]!.output).toEqual(imageOutput);
  });

  it("tool 结果非 JSON（纯文本/被截断）：不回填 output，行为同前", () => {
    const { recordsToDisplay } = useChatRecords();
    const records: ChatMessageRecord[] = [
      {
        id: "m1",
        sessionId: "s1",
        role: "assistant",
        content: [],
        toolCalls: [{ toolCallId: "t1", name: "bash", arguments: {} }],
        createdAt: "2026-08-26T00:00:00.000Z",
      },
      {
        id: "tool_t1",
        sessionId: "s1",
        role: "tool",
        content: [{ type: "text", text: "plain output not json{" }],
        toolCallId: "t1",
        createdAt: "2026-08-26T00:00:01.000Z",
      },
    ];
    const out = recordsToDisplay(records);
    expect(out).toHaveLength(1);
    expect(out[0]!.toolCalls[0]!.output).toBeUndefined();
  });
});

describe("setToolCallOutput", () => {
  it("按 toolCallId 回填结果载荷（流式 tool.result 帧）", () => {
    const messages = makeMessages();
    setToolCallOutput(messages, "t1", { path: "files/images/x.png", persisted: true });
    expect(messages[0]!.toolCalls[0]!.output).toEqual({ path: "files/images/x.png", persisted: true });
    expect(messages[1]!.toolCalls[0]!.output).toBeUndefined();
  });

  it("找不到 toolCallId 时静默跳过", () => {
    const messages = makeMessages();
    expect(() => setToolCallOutput(messages, "nope", {})).not.toThrow();
  });
});
