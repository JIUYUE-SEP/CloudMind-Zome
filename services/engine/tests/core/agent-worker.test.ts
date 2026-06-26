import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { AgentWorker } from "../../src/core/agent-worker.js";
import { MockLLMProvider } from "../../src/provider/llm.js";
import type { Tool, ToolContext, ToolResult } from "../../src/tools/types.js";
import type { ChatMessage } from "@mindcloud/shared";
import type { LLMEvent } from "../../src/provider/types.js";

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

function makeConfig(provider = new MockLLMProvider()): {
  agentId: string;
  model: string;
  provider: typeof provider;
  tools: Tool[];
  workspaceDir: string;
  messageRepository: { append: () => Promise<void>; listBySession: () => Promise<[]> };
  requiresApproval: () => Promise<true>;
} {
  return {
    agentId: "agent-1",
    model: "mock",
    provider,
    tools: [dummyTool],
    workspaceDir: "/tmp",
    messageRepository: { append: async () => {}, listBySession: async () => [] },
    requiresApproval: async () => true,
  };
}

function userMessage(text: string): ChatMessage {
  return {
    id: "1",
    role: "user",
    content: [{ type: "text", text }],
    createdAt: "2024-01-01",
  };
}

describe("AgentWorker", () => {
  it("processes a job and emits streaming events", async () => {
    const worker = new AgentWorker(makeConfig());
    const events: LLMEvent[] = [];

    worker.enqueue({
      id: "j1",
      messages: [userMessage("hi")],
      onEvent: (e) => events.push(e),
    });

    await vi.waitFor(() => expect(events.some((e) => e.type === "text.delta")).toBe(true));
    await vi.waitFor(() => expect(worker.status).toBe("idle"));
  });

  it("queues multiple jobs and processes them sequentially", async () => {
    const worker = new AgentWorker(makeConfig());
    const jobEvents: Map<string, LLMEvent[]> = new Map();

    worker.enqueue({
      id: "j1",
      messages: [userMessage("first")],
      onEvent: (e) => {
        if (!jobEvents.has("j1")) jobEvents.set("j1", []);
        jobEvents.get("j1")!.push(e);
      },
    });
    worker.enqueue({
      id: "j2",
      messages: [userMessage("second")],
      onEvent: (e) => {
        if (!jobEvents.has("j2")) jobEvents.set("j2", []);
        jobEvents.get("j2")!.push(e);
      },
    });

    await vi.waitFor(() => expect(worker.status).toBe("idle"));
    expect(jobEvents.get("j1")?.some((e) => e.type === "text.delta")).toBe(true);
    expect(jobEvents.get("j2")?.some((e) => e.type === "text.delta")).toBe(true);
  });

  it("pauses and resumes the queue", async () => {
    const worker = new AgentWorker(makeConfig());
    const events: LLMEvent[] = [];

    worker.pause();
    worker.enqueue({
      id: "j1",
      messages: [userMessage("hi")],
      onEvent: (e) => events.push(e),
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events.length).toBe(0);
    expect(worker.status).toBe("paused");

    worker.resume();
    await vi.waitFor(() => expect(events.some((e) => e.type === "text.delta")).toBe(true));
    await vi.waitFor(() => expect(worker.status).toBe("idle"));
  });
});
