import { describe, it, expect } from "vitest";
import { z } from "zod";
import { runTurn } from "../../src/core/react/turn.js";
import { MockLLMProvider } from "../../src/provider/llm.js";
import { ContextPipeline } from "../../src/context/pipeline.js";
import { getTokenCounter } from "../../src/context/token-counter.js";
import type { Tool, ToolContext, ToolResult } from "../../src/tools/types.js";
import type { ChatMessage } from "@mindcloud/shared";
import type { LLMProvider, LLMChatParams, LLMEvent } from "../../src/provider/types.js";

function userMessage(text: string): ChatMessage {
  return {
    id: "1",
    role: "user",
    content: [{ type: "text", text }],
    createdAt: "2024-01-01",
  };
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

class ToolThenStopProvider implements LLMProvider {
  name = "tool-then-stop";
  private step = 0;
  supportsModel() {
    return true;
  }
  async *chat(params: LLMChatParams): AsyncIterable<LLMEvent> {
    void params;
    if (this.step === 0) {
      this.step++;
      yield { type: "tool.call", toolCallId: "tc_1", name: "dummy", arguments: { value: "x" } };
    } else {
      yield { type: "text.delta", delta: "done" };
    }
    yield { type: "step.end" };
  }
}

class MultiToolProvider implements LLMProvider {
  name = "multi-tool";
  supportsModel() {
    return true;
  }
  async *chat(params: LLMChatParams): AsyncIterable<LLMEvent> {
    void params;
    yield { type: "tool.call", toolCallId: "tc_1", name: "write_a", arguments: {} };
    yield { type: "tool.call", toolCallId: "tc_2", name: "write_b", arguments: {} };
    yield { type: "step.end" };
  }
}

class ApprovalProvider implements LLMProvider {
  name = "approval";
  supportsModel() {
    return true;
  }
  async *chat(params: LLMChatParams): AsyncIterable<LLMEvent> {
    void params;
    yield { type: "tool.call", toolCallId: "tc_1", name: "tracked", arguments: {} };
    yield { type: "step.end" };
  }
}

describe("runTurn", () => {
  it("returns assistant message without tool calls", async () => {
    const provider = new MockLLMProvider();
    const events: LLMEvent[] = [];

    await runTurn(
      {
        provider,
        model: "mock",
        messages: [userMessage("hi")],
        tools: [],
        toolCtx: {
          agentId: "a",
          workspaceDir: "/tmp",
          tools: new Map(),
          approve: async () => true,
          emit: (e) => events.push(e),
        },
      },
      (e) => events.push(e)
    );

    expect(events.some((e) => e.type === "text.delta")).toBe(true);
    expect(events.some((e) => e.type === "step.end")).toBe(true);
  });

  it("executes a single tool call and continues", async () => {
    const provider = new ToolThenStopProvider();
    const events: LLMEvent[] = [];

    await runTurn(
      {
        provider,
        model: "tool-then-stop",
        messages: [userMessage("call dummy")],
        tools: [
          {
            type: "function",
            function: { name: "dummy", description: "dummy", parameters: {} },
          },
        ],
        toolCtx: {
          agentId: "a",
          workspaceDir: "/tmp",
          tools: new Map([["dummy", dummyTool]]),
          approve: async () => true,
          emit: (e) => events.push(e),
        },
      },
      (e) => events.push(e)
    );

    expect(events.some((e) => e.type === "tool.call" && e.name === "dummy")).toBe(true);
    expect(
      events.some(
        (e) =>
          e.type === "tool.result" &&
          e.toolCallId === "tc_1" &&
          typeof e.output === "object" &&
          e.output !== null &&
          (e.output as ToolResult).success === true
      )
    ).toBe(true);
    expect(events.some((e) => e.type === "text.delta" && e.delta === "done")).toBe(true);
  });

  it("serializes conflicting tool calls", async () => {
    let counter = 0;
    const counterTool: Tool = {
      name: "counter",
      description: "Counter tool",
      parameters: z.object({ action: z.enum(["increment", "read"]) }),
      accesses: [{ resource: "memory", action: "write" }],
      async execute(ctx: ToolContext, args: unknown): Promise<ToolResult> {
        void ctx;
        const { action } = args as { action: "increment" | "read" };
        if (action === "increment") {
          counter++;
          return { success: true, output: counter };
        }
        return { success: true, output: counter };
      },
    };

    const provider: LLMProvider = {
      name: "counter-mock",
      supportsModel: () => true,
      async *chat(params: LLMChatParams): AsyncIterable<LLMEvent> {
        void params;
        yield { type: "tool.call", toolCallId: "tc_1", name: "counter", arguments: { action: "increment" } };
        yield { type: "tool.call", toolCallId: "tc_2", name: "counter", arguments: { action: "read" } };
        yield { type: "step.end" };
      },
    };

    const events: LLMEvent[] = [];
    await runTurn(
      {
        provider,
        model: "counter-mock",
        messages: [userMessage("counter")],
        tools: [],
        toolCtx: {
          agentId: "a",
          workspaceDir: "/tmp",
          tools: new Map([["counter", counterTool]]),
          approve: async () => true,
          emit: (e) => events.push(e),
        },
        maxSteps: 1,
      },
      (e) => events.push(e)
    );

    const readResult = events.find(
      (e): e is LLMEvent & { type: "tool.result"; output: ToolResult } =>
        e.type === "tool.result" && e.toolCallId === "tc_2"
    );
    expect(readResult).toBeDefined();
    expect((readResult!.output as ToolResult).output).toBe(1);
  });

  it("runs non-conflicting tool calls in parallel", async () => {
    const flags = { a: false, b: false };
    const writeA: Tool = {
      name: "write_a",
      description: "Write A",
      parameters: z.object({}),
      accesses: [{ resource: "file", action: "write", path: "/a" }],
      async execute(ctx: ToolContext, args: unknown): Promise<ToolResult> {
        void ctx;
        void args;
        flags.a = true;
        return { success: true, output: "a" };
      },
    };
    const writeB: Tool = {
      name: "write_b",
      description: "Write B",
      parameters: z.object({}),
      accesses: [{ resource: "file", action: "write", path: "/b" }],
      async execute(ctx: ToolContext, args: unknown): Promise<ToolResult> {
        void ctx;
        void args;
        flags.b = true;
        return { success: true, output: "b" };
      },
    };

    const events: LLMEvent[] = [];
    await runTurn(
      {
        provider: new MultiToolProvider(),
        model: "multi-tool",
        messages: [userMessage("parallel")],
        tools: [],
        toolCtx: {
          agentId: "a",
          workspaceDir: "/tmp",
          tools: new Map([
            ["write_a", writeA],
            ["write_b", writeB],
          ]),
          approve: async () => true,
          emit: (e) => events.push(e),
        },
        maxSteps: 1,
      },
      (e) => events.push(e)
    );

    expect(flags.a).toBe(true);
    expect(flags.b).toBe(true);
    expect(events.filter((e) => e.type === "tool.result").length).toBe(2);
  });

  it("denies tool execution when approval is rejected", async () => {
    let executed = false;
    const trackedTool: Tool = {
      name: "tracked",
      description: "Tracked tool",
      parameters: z.object({}),
      accesses: [{ resource: "file", action: "read" }],
      async execute(ctx: ToolContext, args: unknown): Promise<ToolResult> {
        void ctx;
        void args;
        executed = true;
        return { success: true, output: "ok" };
      },
    };

    const events: LLMEvent[] = [];
    await runTurn(
      {
        provider: new ApprovalProvider(),
        model: "approval",
        messages: [userMessage("reject")],
        tools: [],
        toolCtx: {
          agentId: "a",
          workspaceDir: "/tmp",
          tools: new Map([["tracked", trackedTool]]),
          approve: async () => false,
          emit: (e) => events.push(e),
        },
        maxSteps: 1,
      },
      (e) => events.push(e)
    );

    expect(executed).toBe(false);
    const result = events.find(
      (e): e is LLMEvent & { type: "tool.result"; output: { error: string } } =>
        e.type === "tool.result" && e.toolCallId === "tc_1"
    );
    expect(result).toBeDefined();
    expect((result!.output as { error: string }).error).toBe("Approval denied");
  });

  it("M1：超大工具结果在进入 context 前被截断（保留头尾 + 省略标记）", async () => {
    // ~13 万字符 ≈ 3 万+ token，远超下面 800 token 的单条上限
    const hugeText = "lorem ipsum dolor sit amet ".repeat(5000);
    const hugeTool: Tool = {
      name: "huge",
      description: "returns a huge output",
      parameters: z.object({}),
      accesses: [{ resource: "file", action: "read" }],
      async execute(ctx: ToolContext, args: unknown): Promise<ToolResult> {
        void ctx;
        void args;
        return { success: true, output: hugeText };
      },
    };
    class CaptureSecondStepProvider implements LLMProvider {
      name = "capture-second";
      private step = 0;
      captured: LLMChatParams | undefined;
      supportsModel() {
        return true;
      }
      async *chat(params: LLMChatParams): AsyncIterable<LLMEvent> {
        if (this.step++ === 0) {
          yield { type: "tool.call", toolCallId: "tc_1", name: "huge", arguments: {} };
        } else {
          this.captured = params;
          yield { type: "text.delta", delta: "done" };
        }
        yield { type: "step.end" };
      }
    }

    const provider = new CaptureSecondStepProvider();
    // budget = 4000 → 单条工具结果上限 = 4000 × 20% = 800 tokens
    const pipeline = new ContextPipeline({ maxContextTokens: 4000, reserveRatio: 0 });
    await runTurn(
      {
        provider,
        model: "mock",
        messages: [userMessage("call huge")],
        tools: [{ type: "function", function: { name: "huge", description: "huge", parameters: {} } }],
        toolCtx: {
          agentId: "a",
          workspaceDir: "/tmp",
          tools: new Map([["huge", hugeTool]]),
          approve: async () => true,
          emit: () => {},
        },
        contextPipeline: {
          pipeline,
          input: { agentId: "a", mindContext: "", sourceId: "s1" },
        },
      },
      () => {}
    );

    const toolMsg = provider.captured!.messages.find((m) => m.role === "tool")!;
    const text = (toolMsg.content[0] as { type: "text"; text: string }).text;
    // 真实 tiktoken 计数 ≤ 预算的 20%，且保留头尾 + 省略标记
    expect(getTokenCounter().countText(text)).toBeLessThanOrEqual(800);
    expect(text.length).toBeLessThan(hugeText.length);
    expect(text).toContain("省略");
    // 工具返回的是 ToolResult 对象，落 context 前经 JSON 序列化（与 step.ts 行为一致）
    const serialized = JSON.stringify({ success: true, output: hugeText });
    expect(text.startsWith(serialized.slice(0, 100))).toBe(true);
    expect(text.endsWith(serialized.slice(-100))).toBe(true);
  });
});
