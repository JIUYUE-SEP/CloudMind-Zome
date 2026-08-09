import { describe, it, expect } from "vitest";
import { z } from "zod";
import { executeLoopStep, StepStreamError } from "../../../src/core/react/step.js";
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

class UsageProvider implements LLMProvider {
  name = "usage";
  supportsModel() {
    return true;
  }
  async *chat(params: LLMChatParams): AsyncIterable<LLMEvent> {
    void params;
    yield { type: "text.delta", delta: "done" };
    yield { type: "step.end", finishReason: "stop", usage: { promptTokens: 123, completionTokens: 45 } };
  }
}

class ToolUsageProvider implements LLMProvider {
  name = "tool-usage";
  supportsModel() {
    return true;
  }
  async *chat(params: LLMChatParams): AsyncIterable<LLMEvent> {
    void params;
    yield { type: "tool.call", toolCallId: "tc_1", name: "dummy", arguments: { value: "a" } };
    yield { type: "step.end", usage: { promptTokens: 10, completionTokens: 20 } };
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
  approve: () => Promise<true>;
  emit: () => void;
} {
  return {
    agentId: "a",
    workspaceDir: "/tmp",
    tools: new Map([[dummyTool.name, dummyTool]]),
    approve: async () => true,
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

  it("透传 provider step.end 的 usage 到 StepResult（改动三数据流）", async () => {
    const result = await executeLoopStep(
      {
        provider: new UsageProvider(),
        model: "usage",
        messages: [userMessage("hi")],
        tools: [],
        toolCtx: makeToolCtx(),
      },
      () => {}
    );

    expect(result.usage).toEqual({ promptTokens: 123, completionTokens: 45 });
  });

  it("工具调用路径同样透传 usage（tool_use 步）", async () => {
    const result = await executeLoopStep(
      {
        provider: new ToolUsageProvider(),
        model: "tool-usage",
        messages: [userMessage("call tools")],
        tools: [],
        toolCtx: makeToolCtx(),
      },
      () => {}
    );

    expect(result.stopReason).toBe("tool_use");
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 20 });
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

describe("executeLoopStep 流式中断半截消息（P3-3）", () => {
  it("provider 中途抛错：已累积文本构造 incomplete 半截消息随 StepStreamError 上抛", async () => {
    class CrashMidStreamProvider implements LLMProvider {
      name = "crash-mid";
      supportsModel() {
        return true;
      }
      async *chat(): AsyncIterable<LLMEvent> {
        yield { type: "text.delta", delta: "说到一半的回复" };
        throw new Error("stream broken");
      }
    }

    try {
      await executeLoopStep(
        {
          provider: new CrashMidStreamProvider(),
          model: "mock",
          messages: [userMessage("hi")],
          tools: [],
          toolCtx: makeToolCtx(),
        },
        () => {},
      );
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(StepStreamError);
      const partial = (err as StepStreamError).partialMessage;
      expect(partial).toBeDefined();
      expect(partial!.role).toBe("assistant");
      expect(partial!.incomplete).toBe(true);
      expect(partial!.content).toEqual([{ type: "text", text: "说到一半的回复" }]);
      expect(partial!.toolCalls).toBeUndefined();
    }
  });

  it("中断前已收到 tool.call：半截消息不带 toolCalls（结果从未执行，带上即成孤儿）", async () => {
    class CrashAfterToolCallProvider implements LLMProvider {
      name = "crash-after-toolcall";
      supportsModel() {
        return true;
      }
      async *chat(): AsyncIterable<LLMEvent> {
        yield { type: "text.delta", delta: "让我查一下" };
        yield { type: "tool.call", toolCallId: "tc_1", name: "dummy", arguments: {} };
        throw new Error("stream broken");
      }
    }

    try {
      await executeLoopStep(
        {
          provider: new CrashAfterToolCallProvider(),
          model: "mock",
          messages: [userMessage("hi")],
          tools: [],
          toolCtx: makeToolCtx(),
        },
        () => {},
      );
      expect.unreachable("should throw");
    } catch (err) {
      const partial = (err as StepStreamError).partialMessage;
      expect(partial).toBeDefined();
      expect(partial!.toolCalls).toBeUndefined();
      expect(partial!.content).toEqual([{ type: "text", text: "让我查一下" }]);
    }
  });

  it("无任何累积内容时抛错：partialMessage 为 undefined", async () => {
    class CrashImmediatelyProvider implements LLMProvider {
      name = "crash-immediate";
      supportsModel() {
        return true;
      }
      async *chat(): AsyncIterable<LLMEvent> {
        throw new Error("connect failed");
      }
    }

    await expect(
      executeLoopStep(
        {
          provider: new CrashImmediatelyProvider(),
          model: "mock",
          messages: [userMessage("hi")],
          tools: [],
          toolCtx: makeToolCtx(),
        },
        () => {},
      ),
    ).rejects.toMatchObject({ name: "StepStreamError", partialMessage: undefined });
  });
});
