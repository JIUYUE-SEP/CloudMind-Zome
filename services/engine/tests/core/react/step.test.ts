import { describe, it, expect } from "vitest";
import { z } from "zod";
import { executeLoopStep } from "../../../src/core/react/step.js";
import type { LLMProvider, LLMChatParams, LLMEvent } from "../../../src/provider/types.js";
import type { ChatMessage } from "@mindcloud/shared";
import type { Tool, ToolContext, ToolResult } from "../../../src/tools/types.js";

function userMessage(text: string): ChatMessage {
  return {
    id: "1",
    role: "user",
    content: [{ type: "text", text }],
    createdAt: "2024-01-01",
  };
}

class MaxTokensProvider implements LLMProvider {
  name = "max-tokens";
  supportsModel() {
    return true;
  }
  async *chat(params: LLMChatParams): AsyncIterable<LLMEvent> {
    void params;
    yield { type: "text.delta", delta: "partial" };
    yield { type: "step.end", finishReason: "length" };
  }
}

class StopProvider implements LLMProvider {
  name = "stop";
  supportsModel() {
    return true;
  }
  async *chat(params: LLMChatParams): AsyncIterable<LLMEvent> {
    void params;
    yield { type: "text.delta", delta: "done" };
    yield { type: "step.end", finishReason: "stop" };
  }
}

class MultiToolProvider implements LLMProvider {
  name = "multi-tool";
  supportsModel() {
    return true;
  }
  async *chat(params: LLMChatParams): AsyncIterable<LLMEvent> {
    void params;
    yield { type: "tool.call", toolCallId: "tc_1", name: "dummy", arguments: { value: "a" } };
    yield { type: "tool.call", toolCallId: "tc_2", name: "dummy", arguments: { value: "b" } };
    yield { type: "step.end" };
  }
}

class UnknownToolProvider implements LLMProvider {
  name = "unknown-tool";
  supportsModel() {
    return true;
  }
  async *chat(params: LLMChatParams): AsyncIterable<LLMEvent> {
    void params;
    yield { type: "tool.call", toolCallId: "tc_unknown", name: "missing", arguments: {} };
    yield { type: "step.end" };
  }
}

const dummyTool: Tool = {
  name: "dummy",
  description: "A dummy tool for testing",
  parameters: z.object({ value: z.string() }),
  accesses: [{ resource: "file", action: "read" }],
  async execute(ctx: ToolContext, args: unknown): Promise<ToolResult> {
    void ctx;
    return { success: true, output: `got ${(args as { value: string }).value}` };
  },
};

function makeToolCtx(): {
  agentId: string;
  workspaceDir: string;
  tools: Map<string, Tool>;
  requiresApproval: () => Promise<true>;
  emit: () => void;
} {
  return {
    agentId: "a",
    workspaceDir: "/tmp",
    tools: new Map([[dummyTool.name, dummyTool]]),
    requiresApproval: async () => true,
    emit: () => {},
  };
}

describe("executeLoopStep", () => {
  it("returns max_tokens stop reason when finishReason is length", async () => {
    const result = await executeLoopStep(
      {
        provider: new MaxTokensProvider(),
        model: "max-tokens",
        messages: [userMessage("hi")],
        tools: [],
        toolCtx: makeToolCtx(),
      },
      () => {}
    );

    expect(result.stopReason).toBe("max_tokens");
  });

  it("returns stop reason when finishReason is stop", async () => {
    const result = await executeLoopStep(
      {
        provider: new StopProvider(),
        model: "stop",
        messages: [userMessage("hi")],
        tools: [],
        toolCtx: makeToolCtx(),
      },
      () => {}
    );

    expect(result.stopReason).toBe("stop");
  });

  it("records toolCalls on assistant message when tools are called", async () => {
    const result = await executeLoopStep(
      {
        provider: new MultiToolProvider(),
        model: "multi-tool",
        messages: [userMessage("call tools")],
        tools: [],
        toolCtx: makeToolCtx(),
      },
      () => {}
    );

    expect(result.stopReason).toBe("tool_use");
    expect(result.assistantMessage.toolCalls).toHaveLength(2);
    expect(result.assistantMessage.toolCalls).toEqual([
      { toolCallId: "tc_1", name: "dummy", arguments: { value: "a" } },
      { toolCallId: "tc_2", name: "dummy", arguments: { value: "b" } },
    ]);
  });

  it("includes unknown tool errors in toolMessages so they enter conversation context", async () => {
    const result = await executeLoopStep(
      {
        provider: new UnknownToolProvider(),
        model: "unknown-tool",
        messages: [userMessage("call unknown")],
        tools: [],
        toolCtx: makeToolCtx(),
      },
      () => {}
    );

    expect(result.stopReason).toBe("tool_use");
    expect(result.toolMessages).toHaveLength(1);
    expect(result.toolMessages?.[0].role).toBe("tool");
    expect(result.toolMessages?.[0].content).toEqual([
      { type: "text", text: JSON.stringify({ error: "Unknown tool: missing" }) },
    ]);
  });
});
