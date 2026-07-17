import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { AgentWorker } from "../../src/core/agent-worker.js";
import { MockLLMProvider } from "../../src/provider/llm.js";
import type { Tool, ToolContext, ToolResult } from "../../src/tools/types.js";
import type { ChatMessage } from "@mindcloud/shared";
import type { LLMEvent, LLMProvider, LLMChatParams } from "../../src/provider/types.js";
import type { IMessageRepository } from "../../src/memory/repositories/types.js";

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

class CapturingProvider implements LLMProvider {
  name = "capturing";
  capturedParams: LLMChatParams | undefined;

  supportsModel() {
    return true;
  }

  async *chat(params: LLMChatParams): AsyncIterable<LLMEvent> {
    this.capturedParams = params;
    yield { type: "text.delta", delta: "ok" };
    yield { type: "step.end" };
  }
}

function makeConfig(
  provider: LLMProvider = new MockLLMProvider(),
  messageRepository: Partial<IMessageRepository> = {},
  tools: Tool[] = [dummyTool]
): {
  agentId: string;
  model: string;
  provider: LLMProvider;
  tools: Tool[];
  workspaceDir: string;
  messageRepository: IMessageRepository;
  approve: () => Promise<true>;
} {
  return {
    agentId: "agent-1",
    model: "mock",
    provider,
    tools,
    workspaceDir: "/tmp",
    messageRepository: {
      append: async () => {},
      listBySession: async () => [],
      ...messageRepository,
    } as IMessageRepository,
    approve: async () => true,
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

  it("runScheduledTask persists user messages when sessionId is provided", async () => {
    const append = vi.fn(async () => {});
    const worker = new AgentWorker(makeConfig(new MockLLMProvider(), { append, listBySession: async () => [] }));
    const enqueueSpy = vi.spyOn(worker, "enqueue");

    await worker.runScheduledTask({
      id: "sched-1",
      sessionId: "sess-1",
      messages: [userMessage("hi")],
      onEvent: () => {},
    });

    expect(append).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({ role: "user", sessionId: "sess-1", content: [{ type: "text", text: "hi" }] })
    );
    expect(enqueueSpy).toHaveBeenCalledWith(expect.objectContaining({ id: "sched-1", sessionId: "sess-1" }));
  });

  it("runScheduledTask does not persist user messages without sessionId", async () => {
    const append = vi.fn(async () => {});
    const worker = new AgentWorker(makeConfig(new MockLLMProvider(), { append, listBySession: async () => [] }));

    await worker.runScheduledTask({
      id: "sched-1",
      messages: [userMessage("hi")],
      onEvent: () => {},
    });

    expect(append).not.toHaveBeenCalled();
  });

  it("runScheduledTask logs and continues when persistence fails", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const append = vi.fn(async () => {
      throw new Error("disk full");
    });
    const worker = new AgentWorker(makeConfig(new MockLLMProvider(), { append, listBySession: async () => [] }));
    const enqueueSpy = vi.spyOn(worker, "enqueue");

    await worker.runScheduledTask({
      id: "sched-1",
      sessionId: "sess-1",
      messages: [userMessage("hi")],
      onEvent: () => {},
    });

    expect(append).toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith("failed to persist scheduler user message", expect.any(Error));
    expect(enqueueSpy).toHaveBeenCalledWith(expect.objectContaining({ id: "sched-1", sessionId: "sess-1" }));

    consoleSpy.mockRestore();
  });

  it("injects code mode system prompt at the front of messages", async () => {
    const provider = new CapturingProvider();
    const worker = new AgentWorker(makeConfig(provider));

    worker.enqueue({
      id: "j-code",
      messages: [userMessage("hi")],
      mode: "code",
      onEvent: () => {},
    });

    await vi.waitFor(() => expect(worker.status).toBe("idle"));

    const messages = provider.capturedParams?.messages;
    expect(messages).toBeDefined();
    expect(messages?.[0].role).toBe("system");
    expect(messages?.[0].content).toEqual([
      { type: "text", text: "You are in code assistant mode. You can list files, read/write/edit files under the project workspace, and run shell commands. Always explain your intent before making changes." },
    ]);
    expect(messages?.[1]).toEqual(userMessage("hi"));
  });

  it("does not inject system prompt in chat mode", async () => {
    const provider = new CapturingProvider();
    const worker = new AgentWorker(makeConfig(provider));

    worker.enqueue({
      id: "j-chat",
      messages: [userMessage("hi")],
      mode: "chat",
      onEvent: () => {},
    });

    await vi.waitFor(() => expect(worker.status).toBe("idle"));

    const messages = provider.capturedParams?.messages;
    expect(messages?.[0].role).not.toBe("system");
    expect(messages?.[0]).toEqual(userMessage("hi"));
  });

  it("does not persist system prompt to message repository", async () => {
    const append = vi.fn(async () => {});
    const provider = new CapturingProvider();
    const worker = new AgentWorker(makeConfig(provider, { append, listBySession: async () => [] }));

    worker.enqueue({
      id: "j-code",
      messages: [userMessage("hi")],
      mode: "code",
      sessionId: "sess-1",
      onEvent: () => {},
    });

    await vi.waitFor(() => expect(worker.status).toBe("idle"));

    const messages = provider.capturedParams?.messages;
    expect(messages?.[0].role).toBe("system");

    const appendCalls = (append.mock.calls as unknown as [ChatMessage][]).map((c) => c[0]);
    expect(appendCalls.some((m) => m.role === "system")).toBe(false);
    expect(appendCalls.some((m) => m.role === "assistant")).toBe(true);
  });

  it("persists tool-call turns in chronological order", async () => {
    class ToolThenStopProvider implements LLMProvider {
      name = "tool-then-stop";
      private calls = 0;
      supportsModel() {
        return true;
      }
      async *chat(): AsyncIterable<LLMEvent> {
        this.calls++;
        if (this.calls === 1) {
          yield { type: "tool.call", toolCallId: "tc_1", name: "dummy", arguments: { value: "x" } };
        } else {
          yield { type: "text.delta", delta: "done" };
        }
        yield { type: "step.end" };
      }
    }

    const appended: (ChatMessage & { sessionId?: string })[] = [];
    const worker = new AgentWorker(
      makeConfig(new ToolThenStopProvider(), {
        append: async (msg) => {
          appended.push(msg);
        },
        listBySession: async () => [],
      })
    );

    worker.enqueue({
      id: "j-tools",
      messages: [userMessage("use tool")],
      sessionId: "sess-1",
      onEvent: () => {},
    });

    await vi.waitFor(() => expect(worker.status).toBe("idle"));

    // 中间步骤带 toolCalls 的 assistant 必须先于其 tool 结果消息持久化，
    // 否则下一轮加载历史后 OpenAI 会因孤儿 tool 消息拒绝请求。
    expect(appended.map((m) => m.role)).toEqual(["assistant", "tool", "assistant"]);
    expect(appended[0].toolCalls?.[0]?.toolCallId).toBe("tc_1");
    expect(appended[1].toolCallId).toBe("tc_1");
    expect(appended.every((m) => m.sessionId === "sess-1")).toBe(true);
  });

  it("injects skill prompts into the system message", async () => {
    const provider = new CapturingProvider();
    const worker = new AgentWorker({
      ...makeConfig(provider),
      skillPrompts: ["# Core Skill\nDo core things."],
    });

    worker.enqueue({
      id: "j-skill",
      messages: [userMessage("hi")],
      onEvent: () => {},
    });

    await vi.waitFor(() => expect(worker.status).toBe("idle"));

    const messages = provider.capturedParams?.messages;
    expect(messages?.[0].role).toBe("system");
    expect(messages?.[0].content).toEqual([
      { type: "text", text: "# Skills\n\n# Core Skill\nDo core things." },
    ]);
  });

  it("calls onDone without error after a successful job", async () => {
    const worker = new AgentWorker(makeConfig());
    const onDone = vi.fn();

    worker.enqueue({
      id: "j-done",
      messages: [userMessage("hi")],
      onEvent: () => {},
      onDone,
    });

    await vi.waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(onDone).toHaveBeenCalledWith(undefined);
  });

  it("calls onDone with the caught error when the job fails", async () => {
    class FailingProvider implements LLMProvider {
      name = "failing";
      supportsModel() {
        return true;
      }
      async *chat(): AsyncIterable<LLMEvent> {
        throw new Error("provider exploded");
        yield { type: "step.end" };
      }
    }

    const worker = new AgentWorker(makeConfig(new FailingProvider()));
    const onDone = vi.fn();

    worker.enqueue({
      id: "j-fail",
      messages: [userMessage("hi")],
      onEvent: () => {},
      onDone,
    });

    await vi.waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(String(onDone.mock.calls[0][0])).toContain("provider exploded");
    await vi.waitFor(() => expect(worker.status).toBe("idle"));
  });

  it("skips a job whose signal is already aborted without invoking the provider", async () => {
    const provider = new CapturingProvider();
    const worker = new AgentWorker(makeConfig(provider));
    const controller = new AbortController();
    controller.abort();
    const onDone = vi.fn();

    worker.enqueue({
      id: "j-aborted",
      messages: [userMessage("hi")],
      signal: controller.signal,
      onEvent: () => {},
      onDone,
    });

    await vi.waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(String(onDone.mock.calls[0][0])).toContain("aborted");
    expect(provider.capturedParams).toBeUndefined();
    await vi.waitFor(() => expect(worker.status).toBe("idle"));
  });

  it("aborts a running turn at the step boundary when the signal fires mid-run", async () => {
    const controller = new AbortController();
    const abortingTool: Tool = {
      name: "aborter",
      description: "aborts the job signal when executed",
      parameters: z.object({}),
      accesses: [],
      async execute(): Promise<ToolResult> {
        controller.abort();
        return { success: true, output: "aborting now" };
      },
    };
    const provider = new MockLLMProvider();
    provider.setNextToolCalls([{ toolCallId: "tc-1", name: "aborter", arguments: {} }]);
    const worker = new AgentWorker(makeConfig(provider, {}, [abortingTool]));
    const onDone = vi.fn();

    worker.enqueue({
      id: "j-mid-abort",
      messages: [userMessage("go")],
      signal: controller.signal,
      onEvent: () => {},
      onDone,
    });

    // 工具执行触发了 abort，下一步步骤边界应抛 aborted 而不是正常收尾
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(String(onDone.mock.calls[0][0])).toContain("aborted");
    await vi.waitFor(() => expect(worker.status).toBe("idle"));
  });

  describe("dangerous tool approval", () => {
    class DangerCallProvider implements LLMProvider {
      name = "danger";
      private calls = 0;
      supportsModel() {
        return true;
      }
      async *chat(): AsyncIterable<LLMEvent> {
        this.calls++;
        if (this.calls === 1) {
          yield { type: "tool.call", toolCallId: "tc_d", name: "danger_tool", arguments: { x: 1 } };
        } else {
          yield { type: "text.delta", delta: "done" };
        }
        yield { type: "step.end" };
      }
    }

    function makeDangerTool(executed: { flag: boolean }): Tool {
      return {
        name: "danger_tool",
        description: "dangerous",
        parameters: z.object({ x: z.number() }),
        accesses: [],
        requiresApproval: true,
        execute: async () => {
          executed.flag = true;
          return { success: true, output: "ran" };
        },
      };
    }

    it("denies dangerous tools when the job has no approval channel", async () => {
      const executed = { flag: false };
      const worker = new AgentWorker(
        makeConfig(new DangerCallProvider(), {}, [makeDangerTool(executed)]),
      );
      const events: LLMEvent[] = [];

      worker.enqueue({ id: "j1", messages: [userMessage("go")], onEvent: (e) => events.push(e) });
      await vi.waitFor(() => expect(worker.status).toBe("idle"));

      expect(executed.flag).toBe(false);
      const result = events.find((e) => e.type === "tool.result");
      expect(JSON.stringify((result as { output: unknown }).output)).toContain("Approval denied");
    });

    it("executes dangerous tools approved via onApprovalRequest", async () => {
      const executed = { flag: false };
      const worker = new AgentWorker(
        makeConfig(new DangerCallProvider(), {}, [makeDangerTool(executed)]),
      );
      const requests: unknown[] = [];

      worker.enqueue({
        id: "j2",
        messages: [userMessage("go")],
        onEvent: () => {},
        onApprovalRequest: async (req) => {
          requests.push(req);
          return true;
        },
      });
      await vi.waitFor(() => expect(worker.status).toBe("idle"));

      expect(executed.flag).toBe(true);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ toolCallId: "tc_d", toolName: "danger_tool" });
    });

    it("denies dangerous tools when onApprovalRequest returns false", async () => {
      const executed = { flag: false };
      const worker = new AgentWorker(
        makeConfig(new DangerCallProvider(), {}, [makeDangerTool(executed)]),
      );

      worker.enqueue({
        id: "j3",
        messages: [userMessage("go")],
        onEvent: () => {},
        onApprovalRequest: async () => false,
      });
      await vi.waitFor(() => expect(worker.status).toBe("idle"));

      expect(executed.flag).toBe(false);
    });
  });
});
