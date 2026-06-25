import { describe, it, expect } from "vitest";
import { SubagentDispatcher } from "../../src/subagent/dispatcher.js";
import { BackgroundManager } from "../../src/subagent/background.js";
import type { AgentConfig, ChatMessage } from "@mindcloud/shared";

describe("SubagentDispatcher", () => {
  it("borrows agent config and runs foreground", async () => {
    const config: AgentConfig = { id: "a2", name: "A2", persona: "", model: "mock", skills: [], tools: [] };
    const dispatcher = new SubagentDispatcher({
      getAgentConfig: async () => config,
      runAgent: async function* () {
        yield { id: "1", role: "assistant", content: [{ type: "text", text: "ok" }], createdAt: "2024-01-01" } as ChatMessage;
      },
    });
    const result = await dispatcher.dispatch("a1", "a2", "do work", { mode: "foreground" });
    expect((result as { messages: ChatMessage[] }).messages).toHaveLength(1);
  });

  it("registers background task and returns task id", async () => {
    const config: AgentConfig = { id: "a2", name: "A2", persona: "", model: "mock", skills: [], tools: [] };
    const background = new BackgroundManager({
      runAgent: async function* () {
        yield { id: "1", role: "assistant", content: [{ type: "text", text: "ok" }], createdAt: "2024-01-01" } as ChatMessage;
      },
    });
    const dispatcher = new SubagentDispatcher({
      getAgentConfig: async () => config,
      runAgent: async function* () {
        yield { id: "1", role: "assistant", content: [{ type: "text", text: "ok" }], createdAt: "2024-01-01" } as ChatMessage;
      },
      background,
    });
    const result = await dispatcher.dispatch("a1", "a2", "do work", { mode: "background" });
    expect(typeof result).toBe("string");
    const bg = background.get(result as string);
    expect(bg).toBeDefined();
    expect(bg?.task.taskDescription).toBe("do work");
  });
});
