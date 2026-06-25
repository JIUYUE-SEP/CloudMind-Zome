import { describe, it, expect } from "vitest";
import { executeLoopStep } from "../../../src/core/react/step.js";
import type { LLMProvider, LLMChatParams, LLMEvent } from "../../../src/provider/types.js";
import type { ChatMessage } from "@mindcloud/shared";
import type { Tool } from "../../../src/tools/types.js";

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
    tools: new Map(),
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
});
