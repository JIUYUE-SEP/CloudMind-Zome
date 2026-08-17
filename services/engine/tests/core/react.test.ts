import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import {
  runTurn,
  MAX_STEPS_SUMMARY_HINT,
  MAX_STEPS_FALLBACK_REPLY,
  CONTEXT_WATERMARK_SUMMARY_HINT,
  CONTEXT_WATERMARK_FALLBACK_REPLY,
  EMPTY_STOP_SUMMARY_HINT,
  TOOL_STEP_OVERFLOW_PLACEHOLDER,
  HANDOFF_WRITING_GUIDANCE,
} from "../../src/core/react/turn.js";
import { MockLLMProvider } from "../../src/provider/llm.js";
import { ModelApiModeRouter } from "../../src/provider/protocols/index.js";
import { ContextPipeline, WATERMARK_REMINDER_PREFIX } from "../../src/context/pipeline.js";
import { getTokenCounter } from "../../src/context/token-counter.js";
import { logger } from "../../src/logger.js";
import type { Tool, ToolContext, ToolResult } from "../../src/tools/types.js";
import type { ChatMessage } from "@mindcloud/shared";
import type {
  LLMProvider,
  LLMProviderProtocol,
  LLMChatParams,
  LLMEvent,
} from "../../src/provider/types.js";

function userMessage(text: string): ChatMessage {
  return {
    id: "1",
    role: "user",
    content: [{ type: "text", text }],
    createdAt: "2024-01-01",
  };
}

function assistantText(message: ChatMessage): string {
  return message.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
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

/** 连续工具调用直到撞顶；兜底总结调用按配置产文本/抛错/空文本，并记录每次调用参数 */
class ToolLoopThenSummaryProvider implements LLMProvider {
  name = "tool-loop-summary";
  calls: LLMChatParams[] = [];
  constructor(
    private summaryBehavior: "text" | "throw" | "empty" = "text",
  ) {}
  supportsModel() {
    return true;
  }
  async *chat(params: LLMChatParams): AsyncIterable<LLMEvent> {
    this.calls.push(params);
    const hasHint = params.messages.some(
      (m) =>
        m.role === "system" &&
        m.content.some((c) => c.type === "text" && c.text.includes("工具调用步数已用完")),
    );
    if (hasHint) {
      if (this.summaryBehavior === "throw") throw new Error("summary down");
      if (this.summaryBehavior === "empty") {
        yield { type: "step.end" };
        return;
      }
      yield { type: "text.delta", delta: "最终答案" };
    } else {
      yield {
        type: "tool.call",
        toolCallId: `tc_${this.calls.length}`,
        name: "dummy",
        arguments: { value: "x" },
      };
    }
    yield { type: "step.end" };
  }
}

/** A1：兜底总结调用时立即 abort 并继续产出（验证 signal 已透传，总结流被快速中止） */
class AbortDuringSummaryProvider extends ToolLoopThenSummaryProvider {
  /** abort 后还成功产出的帧数：executeLoopStep 应在事件边界中止，该计数保持 0 */
  postAbortYields = 0;
  constructor(private abortController: AbortController) {
    super("text");
  }
  async *chat(params: LLMChatParams): AsyncIterable<LLMEvent> {
    this.calls.push(params);
    const hasHint = params.messages.some(
      (m) =>
        m.role === "system" &&
        m.content.some((c) => c.type === "text" && c.text.includes(MAX_STEPS_SUMMARY_HINT)),
    );
    if (hasHint) {
      this.abortController.abort();
      yield { type: "text.delta", delta: "总结半截" };
      this.postAbortYields++;
      yield { type: "step.end" };
      return;
    }
    yield {
      type: "tool.call",
      toolCallId: `tc_${this.calls.length}`,
      name: "dummy",
      arguments: { value: "x" },
    };
    yield { type: "step.end" };
  }
}

/** 工具一步后正常停止，并记录每次调用参数（未撞顶对照组） */
class ToolThenStopCaptureProvider implements LLMProvider {
  name = "tool-then-stop-capture";
  calls: LLMChatParams[] = [];
  private step = 0;
  supportsModel() {
    return true;
  }
  async *chat(params: LLMChatParams): AsyncIterable<LLMEvent> {
    this.calls.push(params);
    if (this.step++ === 0) {
      yield { type: "tool.call", toolCallId: "tc_1", name: "dummy", arguments: { value: "x" } };
    } else {
      yield { type: "text.delta", delta: "done" };
    }
    yield { type: "step.end" };
  }
}

/** 水位测试用：普通调用发工具、撞顶兜底提示时按行为产出文本/抛错/空文本；可带 usage */
class WatermarkToolLoopProvider implements LLMProvider {
  name = "watermark-tool-loop";
  /** F1：水位夹具默认按 openai chat_completions（回传不含 think） */
  readonly protocol: LLMProviderProtocol = "chat_completions";
  calls: LLMChatParams[] = [];
  constructor(
    private usage: { promptTokens: number; completionTokens: number } | undefined = undefined,
    private summaryBehavior: "text" | "throw" | "empty" = "text",
  ) {}
  supportsModel() {
    return true;
  }
  async *chat(params: LLMChatParams): AsyncIterable<LLMEvent> {
    this.calls.push(params);
    const hitSummaryHint = params.messages.some(
      (m) =>
        m.role === "system" &&
        m.content.some(
          (c) =>
            c.type === "text" &&
            (c.text.includes(CONTEXT_WATERMARK_SUMMARY_HINT) ||
              c.text.includes(MAX_STEPS_SUMMARY_HINT)),
        ),
    );
    if (hitSummaryHint) {
      if (this.summaryBehavior === "throw") throw new Error("watermark summary down");
      if (this.summaryBehavior === "empty") {
        yield { type: "step.end" };
        return;
      }
      yield { type: "text.delta", delta: "水位收尾" };
    } else {
      yield {
        type: "tool.call",
        toolCallId: `tc_${this.calls.length}`,
        name: "dummy",
        arguments: { value: "x" },
      };
    }
    yield { type: "step.end", ...(this.usage ? { usage: this.usage } : {}) };
  }
}

/** 快照版水位循环 provider：每次调用深拷贝 params，避免 runTurn 原地 push 污染历史 calls */
class SnapshotWatermarkToolLoopProvider extends WatermarkToolLoopProvider {
  async *chat(params: LLMChatParams): AsyncIterable<LLMEvent> {
    yield* super.chat(structuredClone(params));
  }
}

/** F1：anthropic 协议夹具（think 真回传占窗口，预检必须含 think 计数） */
class AnthropicWatermarkToolLoopProvider extends SnapshotWatermarkToolLoopProvider {
  readonly protocol = "anthropic";
}

/** F1：responses 协议夹具（与 anthropic 同族：think 真回传占窗口，预检必须含 think 计数） */
class ResponsesWatermarkToolLoopProvider extends SnapshotWatermarkToolLoopProvider {
  readonly protocol = "responses";
}

/** 水位测试共用：裸 runTurn（不传 contextPipeline = 傀儡路径形状） */
function runWatermarkTurn(
  provider: WatermarkToolLoopProvider,
  opts: {
    messages?: ChatMessage[];
    contextWindow?: number;
    maxSteps?: number;
    onStepAppended?: (messages: ChatMessage[]) => Promise<void>;
  } = {},
) {
  const events: LLMEvent[] = [];
  return runTurn(
    {
      provider,
      model: "watermark-tool-loop",
      messages: opts.messages ?? [userMessage("查资料")],
      tools: [
        { type: "function", function: { name: "dummy", description: "dummy", parameters: {} } },
      ],
      toolCtx: {
        agentId: "a",
        workspaceDir: "/tmp",
        tools: new Map([["dummy", dummyTool]]),
        approve: async () => true,
        emit: (e) => events.push(e),
      },
      contextWindow: opts.contextWindow,
      maxSteps: opts.maxSteps,
      onStepAppended: opts.onStepAppended,
    },
    (e) => events.push(e),
  );
}

function reminderCount(paramsList: LLMChatParams[]): number {
  // 同一提醒会随 messages 出现在后续多次调用里，按消息 id 去重计数
  const ids = new Set<string>();
  for (const p of paramsList) {
    for (const m of p.messages) {
      if (
        m.role === "system" &&
        m.content.some((c) => c.type === "text" && c.text.includes("[系统提醒]"))
      ) {
        ids.add(m.id);
      }
    }
  }
  return ids.size;
}

function hasWatermarkHint(params: LLMChatParams): boolean {
  return params.messages.some(
    (m) =>
      m.role === "system" &&
      m.content.some((c) => c.type === "text" && c.text.includes(CONTEXT_WATERMARK_SUMMARY_HINT)),
  );
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
    // turn.end 在循环结束后发出且只发一次
    expect(events.at(-1)?.type).toBe("turn.end");
    expect(events.filter((e) => e.type === "turn.end")).toHaveLength(1);
  });

  it("R2 不变量：runTurn 传入型号 ≠ provider.defaultModel 时 warn 一次（不 crash），预检口径仍按主型号", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const usedAdapters: string[] = [];
      const router = new ModelApiModeRouter({
        providerId: "ds-r2-warn",
        provider: {
          apiMode: "chat_completions" as const,
          baseUrl: "https://api.example.com",
          models: [
            { id: "main", displayName: "Main", modelType: "llm" as const },
            { id: "flash", displayName: "Flash", modelType: "llm" as const, apiMode: "responses" as const },
          ],
        },
        defaultModel: "main",
        createAdapter: (_providerId, apiMode) => {
          const mode = apiMode ?? "chat_completions";
          usedAdapters.push(mode);
          return {
            name: mode,
            protocol: mode as LLMProviderProtocol,
            supportsModel: () => true,
            async *chat(params: LLMChatParams): AsyncIterable<LLMEvent> {
              void params;
              yield { type: "text.delta", delta: "ok" };
              yield { type: "step.end" };
            },
          };
        },
      });

      const turnInput = {
        provider: router,
        model: "flash",
        messages: [userMessage("hi")],
        tools: [],
        toolCtx: {
          agentId: "a",
          workspaceDir: "/tmp",
          tools: new Map(),
          approve: async () => true,
          emit: () => {},
        },
        maxSteps: 5,
      };
      await runTurn(turnInput, () => {});
      await runTurn(turnInput, () => {});

      // chat 按实际型号 flash 走 responses 适配器；预检口径仍按 defaultModel=main（chat_completions）
      expect(usedAdapters).toEqual(["responses"]);
      expect(router.protocol).toBe("chat_completions");
      // 同一 provider+型号只 warn 一次
      expect(warn.mock.calls.filter((c) => String(c[1]).includes("runTurn 传入型号"))).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("多步 ReAct：每步发 step.end，整轮只发一次 turn.end", async () => {
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

    // tool_use step + final stop step = 2 个 step.end，turn.end 只在末尾一次
    expect(events.filter((e) => e.type === "step.end")).toHaveLength(2);
    expect(events.filter((e) => e.type === "turn.end")).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("turn.end");
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
    const successfulResults = events.filter(
      (e): e is LLMEvent & { type: "tool.result"; output: ToolResult } =>
        e.type === "tool.result" && (e.output as ToolResult)?.success === true,
    );
    expect(successfulResults).toHaveLength(2);
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

  it("撞顶兜底：maxSteps 全部消耗在工具循环时，强制一次无工具总结并产出最终回复", async () => {
    const provider = new ToolLoopThenSummaryProvider();
    const events: LLMEvent[] = [];
    const result = await runTurn(
      {
        provider,
        model: "tool-loop-summary",
        messages: [userMessage("查资料")],
        tools: [
          { type: "function", function: { name: "dummy", description: "dummy", parameters: {} } },
        ],
        toolCtx: {
          agentId: "a",
          workspaceDir: "/tmp",
          tools: new Map([["dummy", dummyTool]]),
          approve: async () => true,
          emit: (e) => events.push(e),
        },
        maxSteps: 2,
      },
      (e) => events.push(e),
    );

    // 2 次工具步 + 1 次兜底总结 = 3 次 LLM 调用
    expect(provider.calls).toHaveLength(3);
    const summaryParams = provider.calls[2]!;
    // 兜底调用不带工具、尾部有 system 提示
    expect(summaryParams.tools).toBeUndefined();
    expect(
      summaryParams.messages.some(
        (m) =>
          m.role === "system" &&
          m.content.some((c) => c.type === "text" && c.text.includes(MAX_STEPS_SUMMARY_HINT)),
      ),
    ).toBe(true);
    // 回合产出 assistant 文本，绝不静默
    expect(assistantText(result.assistantMessage)).toBe("最终答案");
    expect(
      result.appended.at(-1)!.content.some((c) => c.type === "text" && c.text === "最终答案"),
    ).toBe(true);
    expect(events.some((e) => e.type === "text.delta" && e.delta === "最终答案")).toBe(true);
    expect(events.filter((e) => e.type === "turn.end")).toHaveLength(1);
  });

  it("撞顶兜底调用失败/空文本：产出兜底回复（不静默）", async () => {
    for (const behavior of ["throw", "empty"] as const) {
      const provider = new ToolLoopThenSummaryProvider(behavior);
      const events: LLMEvent[] = [];
      const result = await runTurn(
        {
          provider,
          model: "tool-loop-summary",
          messages: [userMessage("查资料")],
          tools: [
            { type: "function", function: { name: "dummy", description: "dummy", parameters: {} } },
          ],
          toolCtx: {
            agentId: "a",
            workspaceDir: "/tmp",
            tools: new Map([["dummy", dummyTool]]),
            approve: async () => true,
            emit: (e) => events.push(e),
          },
          maxSteps: 2,
        },
        (e) => events.push(e),
      );

      expect(assistantText(result.assistantMessage)).toBe(MAX_STEPS_FALLBACK_REPLY);
      expect(
        result.appended
          .at(-1)!
          .content.some((c) => c.type === "text" && c.text === MAX_STEPS_FALLBACK_REPLY),
      ).toBe(true);
      expect(
        events.some((e) => e.type === "text.delta" && e.delta === MAX_STEPS_FALLBACK_REPLY),
      ).toBe(true);
    }
  });

  it("A1+M3：兜底总结透传 signal——abort 后总结流早终止，且 abort 不被吞（回合中止）", async () => {
    const controller = new AbortController();
    const provider = new AbortDuringSummaryProvider(controller);
    const events: LLMEvent[] = [];
    await expect(
      runTurn(
        {
          provider,
          model: "tool-loop-summary",
          messages: [userMessage("查资料")],
          tools: [
            { type: "function", function: { name: "dummy", description: "dummy", parameters: {} } },
          ],
          toolCtx: {
            agentId: "a",
            workspaceDir: "/tmp",
            tools: new Map([["dummy", dummyTool]]),
            approve: async () => true,
            emit: (e) => events.push(e),
          },
          maxSteps: 2,
          signal: controller.signal,
        },
        (e) => events.push(e),
      ),
    ).rejects.toThrow("aborted");

    // 2 次工具步 + 1 次兜底总结调用
    expect(provider.calls).toHaveLength(3);
    expect(controller.signal.aborted).toBe(true);
    // abort 后总结流一帧都不再产出（事件边界立即中止）
    expect(provider.postAbortYields).toBe(0);
    // M3：取消即中止——不再降级为兜底回复，兜底文案与半截总结都不上屏，runTurn 无 turn.end
    expect(events.some((e) => e.type === "text.delta" && e.delta === MAX_STEPS_FALLBACK_REPLY)).toBe(
      false,
    );
    expect(events.some((e) => e.type === "text.delta" && e.delta === "总结半截")).toBe(false);
    expect(events.some((e) => e.type === "turn.end")).toBe(false);
  });

  it("未撞顶时行为不变：正常工具循环不触发兜底总结", async () => {
    const provider = new ToolThenStopCaptureProvider();
    const events: LLMEvent[] = [];
    const result = await runTurn(
      {
        provider,
        model: "tool-then-stop-capture",
        messages: [userMessage("call dummy")],
        tools: [
          { type: "function", function: { name: "dummy", description: "dummy", parameters: {} } },
        ],
        toolCtx: {
          agentId: "a",
          workspaceDir: "/tmp",
          tools: new Map([["dummy", dummyTool]]),
          approve: async () => true,
          emit: (e) => events.push(e),
        },
      },
      (e) => events.push(e),
    );

    expect(provider.calls).toHaveLength(2);
    expect(provider.calls.some((p) => p.messages.some((m) => m.role === "system"))).toBe(false);
    expect(assistantText(result.assistantMessage)).toBe("done");
  });
});

describe("上下文水位主裁（改动一）", () => {
  it("水位计算·仅估算：无 usage 时按本地计数超 70%，多步连续只追加一条 system 提醒", async () => {
    const provider = new WatermarkToolLoopProvider();
    const bigUser = userMessage("x".repeat(8000)); // 真实 tiktoken ≈ 2000 tokens
    const base = getTokenCounter().countMessages([bigUser]);
    const toolsTokens = getTokenCounter().countTools([
      { type: "function", function: { name: "dummy", description: "dummy", parameters: {} } },
    ]);
    // 首步后估算 = base + tools + 提醒(≈67) + assistant(toolCalls ≈26) + tool 结果(≈18)；
    // 窗口取该值 / 0.89：预检 ≈0.80 落提醒带、步 1 后未撞顶、步 2 后 ≥0.9（≥2 工具步）
    const window = Math.floor((base + toolsTokens + 67 + 26 + 18) / 0.89);
    const persisted: ChatMessage[] = [];

    const result = await runWatermarkTurn(provider, {
      messages: [bigUser],
      contextWindow: window,
      maxSteps: 20,
      onStepAppended: async (msgs) => {
        persisted.push(...msgs);
      },
    });

    // 全程（含后续步 provider 收到的 messages）只有一条 [系统提醒]
    expect(reminderCount(provider.calls)).toBe(1);
    const reminderText = provider.calls
      .flatMap((p) => p.messages)
      .find(
        (m) =>
          m.role === "system" &&
          m.content.some((c) => c.type === "text" && c.text.includes("[系统提醒]")),
      )!;
    const text = reminderText.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("");
    // F5：生成文案与组装层过滤共用同一前缀常量（消除双处硬编码）
    expect(text.startsWith(WATERMARK_REMINDER_PREFIX)).toBe(true);
    expect(text).toContain(`${window} tokens`);
    expect(text).toContain("请收敛工具调用、优先收尾");

    // 提醒后继续循环：至少两步工具步才撞顶
    expect(provider.calls.filter((p) => !hasWatermarkHint(p)).length).toBeGreaterThanOrEqual(2);

    // 撞顶走兜底，产出落 messages，绝不静默
    expect(assistantText(result.assistantMessage)).toBe("水位收尾");
    expect(
      result.appended.at(-1)!.content.some((c) => c.type === "text" && c.text === "水位收尾"),
    ).toBe(true);

    // 提醒入 appended 且经落盘钩子（历史留痕）；appended 不含交接书
    expect(result.appended.filter((m) => m.role === "system")).toHaveLength(1);
    // 落盘钩子多一条交接书（水位撞顶=换班移交的消息载体）：提醒 1 条 + 交接书 1 条
    const persistedSystems = persisted.filter((m) => m.role === "system");
    expect(persistedSystems).toHaveLength(2);
    expect(
      persistedSystems.some((m) =>
        m.content.some((c) => c.type === "text" && c.text.startsWith("[交接书]")),
      ),
    ).toBe(true);
  });

  it("水位计算·仅 usage：无估算压力时按 provider 实测 90% 撞顶，跳出循环走兜底", async () => {
    const provider = new WatermarkToolLoopProvider({ promptTokens: 800, completionTokens: 100 });
    const result = await runWatermarkTurn(provider, { contextWindow: 1000, maxSteps: 20 });

    // 1 工具步 + 1 次无工具兜底总结 + 1 次瘦身写作调用，未走满 maxSteps
    expect(provider.calls).toHaveLength(3);
    const summaryParams = provider.calls[1]!;
    expect(summaryParams.tools).toBeUndefined();
    expect(hasWatermarkHint(summaryParams)).toBe(true);
    expect(
      provider.calls[2]!.messages.some(
        (m) =>
          m.role === "system" &&
          m.content.some((c) => c.type === "text" && c.text.includes(HANDOFF_WRITING_GUIDANCE)),
      ),
    ).toBe(true);
    expect(assistantText(result.assistantMessage)).toBe("水位收尾");
    expect(
      result.appended.at(-1)!.content.some((c) => c.type === "text" && c.text === "水位收尾"),
    ).toBe(true);
    // 一步直达撞顶：无 70% 提醒
    expect(reminderCount(provider.calls)).toBe(0);
  });

  it("水位计算·双口径取大（usage > 估算）：以实测为准触发 89% 提醒", async () => {
    const provider = new WatermarkToolLoopProvider({ promptTokens: 860, completionTokens: 30 });
    await runWatermarkTurn(provider, { contextWindow: 1000, maxSteps: 3 });

    // 估算（≤ 100 tokens）单独远低于 0.7；usage 890/1000 = 0.89 必须触发提醒
    expect(reminderCount(provider.calls)).toBe(1);
    const text = provider.calls
      .flatMap((p) => p.messages)
      .find((m) => m.role === "system")!
      .content.filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("");
    expect(text).toContain("89%");
  });

  it("水位计算·双口径取大（估算 > usage）：以本地计数为准撞顶（G1 首步预检直落兜底）", async () => {
    const provider = new WatermarkToolLoopProvider({ promptTokens: 200, completionTokens: 50 });
    const bigUser = userMessage("x".repeat(8000)); // 真实 tiktoken ≈ 2000 tokens
    const result = await runWatermarkTurn(provider, {
      messages: [bigUser],
      contextWindow: 1000,
      maxSteps: 20,
    });

    // usage 250/1000 = 0.25 单独不会撞顶；估算（含 tools）> 1.0 → 首步预检即撞顶，
    // 不发任何工具步，直接走水位兜底（G1）
    expect(provider.calls).toHaveLength(2);
    expect(hasWatermarkHint(provider.calls[0]!)).toBe(true);
    expect(reminderCount(provider.calls)).toBe(0);
    expect(assistantText(result.assistantMessage)).toBe("水位收尾");
  });

  it("G1 首步预检撞顶：初始历史即超 0.9W → 不发任何工具步，直接走水位兜底", async () => {
    const provider = new WatermarkToolLoopProvider();
    const bigUser = userMessage("x".repeat(8000)); // ≈ 1000+ tokens
    // 与 runWatermarkTurn 同一份工具定义：估算口径必须含 tools（G3）
    const tools = [
      { type: "function", function: { name: "dummy", description: "dummy", parameters: {} } },
    ];
    const base =
      getTokenCounter().countMessages([bigUser]) + getTokenCounter().countTools(tools);
    const window = Math.floor(base / 0.9); // 首步预检 r ≥ 0.9

    const result = await runWatermarkTurn(provider, {
      messages: [bigUser],
      contextWindow: window,
      maxSteps: 20,
    });

    // 未发任何工具步：一次兜底总结 + 一次瘦身写作调用；无 70% 提醒；回合绝不静默
    expect(provider.calls).toHaveLength(2);
    expect(hasWatermarkHint(provider.calls[0]!)).toBe(true);
    expect(reminderCount(provider.calls)).toBe(0);
    expect(assistantText(result.assistantMessage)).toBe("水位收尾");
    expect(
      result.appended.at(-1)!.content.some((c) => c.type === "text" && c.text === "水位收尾"),
    ).toBe(true);
  });

  it("G1 首步预检提醒：初始 0.7-0.9 注入提醒后正常进循环（每回合一次）", async () => {
    const provider = new SnapshotWatermarkToolLoopProvider();
    const bigUser = userMessage("x".repeat(8000));
    const tools = [
      { type: "function", function: { name: "dummy", description: "dummy", parameters: {} } },
    ];
    const base =
      getTokenCounter().countMessages([bigUser]) + getTokenCounter().countTools(tools);
    const window = Math.floor(base / 0.8); // 首步预检 r ≈ 0.8（提醒带）

    const result = await runWatermarkTurn(provider, {
      messages: [bigUser],
      contextWindow: window,
      maxSteps: 30,
    });

    // 提醒注入后正常进循环：至少一个工具步 + 撞顶兜底；全程只有一条提醒
    expect(provider.calls.length).toBeGreaterThanOrEqual(2);
    expect(provider.calls.filter((p) => !hasWatermarkHint(p)).length).toBeGreaterThanOrEqual(1);
    expect(reminderCount(provider.calls)).toBe(1);
    // 首条请求（第一个工具步）已携带预检提醒
    expect(
      provider.calls[0]!.messages.some(
        (m) =>
          m.role === "system" &&
          m.content.some((c) => c.type === "text" && c.text.includes("[系统提醒]")),
      ),
    ).toBe(true);
    expect(assistantText(result.assistantMessage)).toBe("水位收尾");
    // 提醒入 appended（与循环内提醒同一持久化语义）
    expect(result.appended.filter((m) => m.role === "system")).toHaveLength(1);
  });

  it("G3 估算含工具定义：messages 很小但 tools 很大时，步后水位按估算触发提醒", async () => {
    const provider = new SnapshotWatermarkToolLoopProvider();
    const bigTools = [
      {
        type: "function",
        function: {
          name: "dummy",
          description: "x".repeat(20000), // 工具定义 ≈ 2600+ tokens
          parameters: {},
        },
      },
    ];
    const bigOutputTool: Tool = {
      name: "dummy",
      description: "big output",
      parameters: z.object({}),
      accesses: [{ resource: "file", action: "read" }],
      async execute(): Promise<ToolResult> {
        return { success: true, output: "x".repeat(15000) }; // 工具结果 ≈ 1950 tokens
      },
    };
    const messages = [userMessage("hi")];
    const pre =
      getTokenCounter().countMessages(messages) + getTokenCounter().countTools(bigTools);
    const window = Math.floor(pre / 0.5); // 首步预检 ≈ 0.5（不提醒）

    const events: LLMEvent[] = [];
    const result = await runTurn(
      {
        provider,
        model: "watermark-tool-loop",
        messages,
        tools: bigTools,
        toolCtx: {
          agentId: "a",
          workspaceDir: "/tmp",
          tools: new Map([["dummy", bigOutputTool]]),
          approve: async () => true,
          emit: (e) => events.push(e),
        },
        contextWindow: window,
        maxSteps: 10,
      },
      (e) => events.push(e),
    );

    // 第一步后 messages 增加 ≈1950 tokens：含 tools 的估算跨 0.7 → 循环内提醒；
    // 若估算不含 tools（旧口径），该步后水位仅 ≈0.37，不会触发提醒
    expect(provider.calls.length).toBeGreaterThanOrEqual(2);
    expect(reminderCount(provider.calls)).toBe(1);
    const hasReminder = (params: LLMChatParams) =>
      params.messages.some(
        (m) =>
          m.role === "system" &&
          m.content.some((c) => c.type === "text" && c.text.includes("[系统提醒]")),
      );
    expect(hasReminder(provider.calls[0]!)).toBe(false);
    expect(hasReminder(provider.calls[1]!)).toBe(true);
    expect(assistantText(result.assistantMessage)).toBe("水位收尾");
  });

  it("水位撞顶兜底调用失败/空文本：产出可区分的水位兜底回复（不静默）", async () => {
    for (const behavior of ["throw", "empty"] as const) {
      const provider = new WatermarkToolLoopProvider(
        { promptTokens: 800, completionTokens: 100 },
        behavior,
      );
      const result = await runWatermarkTurn(provider, { contextWindow: 1000 });
      expect(assistantText(result.assistantMessage)).toBe(CONTEXT_WATERMARK_FALLBACK_REPLY);
      expect(
        result.appended
          .at(-1)!
          .content.some((c) => c.type === "text" && c.text === CONTEXT_WATERMARK_FALLBACK_REPLY),
      ).toBe(true);
    }
  });

  it("保险丝：缺省 100 步撞顶，文案与水位撞顶可区分", async () => {
    const provider = new WatermarkToolLoopProvider();
    const result = await runWatermarkTurn(provider); // 不传 maxSteps = 缺省 100

    // 100 工具步 + 1 次兜底总结；小消息无水位压力，纯保险丝撞顶
    expect(provider.calls).toHaveLength(101);
    const summaryParams = provider.calls[100]!;
    expect(
      summaryParams.messages.some(
        (m) =>
          m.role === "system" &&
          m.content.some((c) => c.type === "text" && c.text.includes(MAX_STEPS_SUMMARY_HINT)),
      ),
    ).toBe(true);
    expect(hasWatermarkHint(summaryParams)).toBe(false);
    expect(assistantText(result.assistantMessage)).toBe("水位收尾");
    expect(reminderCount(provider.calls)).toBe(0);
  });

  it("傀儡路径（无 contextPipeline 的裸 runTurn）：水位判据自动生效", async () => {
    const provider = new WatermarkToolLoopProvider({ promptTokens: 800, completionTokens: 100 });
    const result = await runWatermarkTurn(provider, { contextWindow: 1000 });

    expect(provider.calls).toHaveLength(3);
    expect(hasWatermarkHint(provider.calls[1]!)).toBe(true);
    expect(assistantText(result.assistantMessage)).toBe("水位收尾");
  });

  it("F1/H3 openai 协议预检剥 think：think 块不计入估算（openai-compatible 回传丢弃）", async () => {
    const provider = new SnapshotWatermarkToolLoopProvider();
    const thinkBlock: ChatMessage = {
      id: "t1",
      role: "assistant",
      content: [
        { type: "think", think: "x".repeat(20000) }, // ≈ 2600+ tokens
        { type: "text", text: "前面我思考了很多" },
      ],
      createdAt: "2026-01-01",
    };
    const tools = [
      { type: "function", function: { name: "dummy", description: "dummy", parameters: {} } },
    ];
    // 剥 thinking 后预检 ≈ 0.6（不提醒不撞顶）；若计入 think（旧口径）预检 > 1.0 直接兜底
    const base =
      getTokenCounter().countMessages([userMessage("hi"), thinkBlock], { stripThinking: true }) +
      getTokenCounter().countTools(tools);
    const window = Math.floor(base / 0.6);

    const result = await runWatermarkTurn(provider, {
      messages: [userMessage("hi"), thinkBlock],
      contextWindow: window,
      maxSteps: 20,
    });

    // 正常进入工具循环（首个请求无水位提示），而非首步预检直落兜底
    expect(provider.calls.length).toBeGreaterThanOrEqual(2);
    expect(hasWatermarkHint(provider.calls[0]!)).toBe(false);
    expect(assistantText(result.assistantMessage)).toBe("水位收尾");
  });

  it("F1 协议感知：anthropic 预检含 think 不低估（同一窗口下首步直落兜底）", async () => {
    const provider = new AnthropicWatermarkToolLoopProvider();
    const thinkBlock: ChatMessage = {
      id: "t1",
      role: "assistant",
      content: [
        { type: "think", think: "x".repeat(20000) }, // ≈ 2600+ tokens
        { type: "text", text: "前面我思考了很多" },
      ],
      createdAt: "2026-01-01",
    };
    const tools = [
      { type: "function", function: { name: "dummy", description: "dummy", parameters: {} } },
    ];
    // 同一窗口下：含 think 的完整口径 ≥ 0.95 直接撞顶；若错误剥 think 则远低于提醒带
    const strippedBase =
      getTokenCounter().countMessages([userMessage("hi"), thinkBlock], {
        stripThinking: true,
      }) + getTokenCounter().countTools(tools);
    const fullBase =
      getTokenCounter().countMessages([userMessage("hi"), thinkBlock]) +
      getTokenCounter().countTools(tools);
    const window = Math.floor(fullBase / 0.95);
    expect(fullBase / window).toBeGreaterThanOrEqual(0.9);
    expect(strippedBase / window).toBeLessThan(0.7);

    const result = await runWatermarkTurn(provider, {
      messages: [userMessage("hi"), thinkBlock],
      contextWindow: window,
      maxSteps: 20,
    });

    // 未进工具循环：一次兜底总结 + 一次瘦身写作调用；兜底总结携带水位兜底提示
    expect(provider.calls).toHaveLength(2);
    expect(hasWatermarkHint(provider.calls[0]!)).toBe(true);
    expect(assistantText(result.assistantMessage)).toBe("水位收尾");
  });

  it("F1 协议感知：responses 预检含 think 不低估（per-model 覆盖 responses 后走同族口径）", async () => {
    const provider = new ResponsesWatermarkToolLoopProvider();
    const thinkBlock: ChatMessage = {
      id: "t1",
      role: "assistant",
      content: [
        { type: "think", think: "x".repeat(20000) }, // ≈ 2600+ tokens
        { type: "text", text: "前面我思考了很多" },
      ],
      createdAt: "2026-01-01",
    };
    const tools = [
      { type: "function", function: { name: "dummy", description: "dummy", parameters: {} } },
    ];
    // 同一窗口下：含 think 的完整口径 ≥ 0.95 直接撞顶；若错误剥 think 则远低于提醒带
    const strippedBase =
      getTokenCounter().countMessages([userMessage("hi"), thinkBlock], {
        stripThinking: true,
      }) + getTokenCounter().countTools(tools);
    const fullBase =
      getTokenCounter().countMessages([userMessage("hi"), thinkBlock]) +
      getTokenCounter().countTools(tools);
    const window = Math.floor(fullBase / 0.95);
    expect(fullBase / window).toBeGreaterThanOrEqual(0.9);
    expect(strippedBase / window).toBeLessThan(0.7);

    const result = await runWatermarkTurn(provider, {
      messages: [userMessage("hi"), thinkBlock],
      contextWindow: window,
      maxSteps: 20,
    });

    // 未进工具循环：一次兜底总结 + 一次瘦身写作调用；兜底总结携带水位兜底提示
    expect(provider.calls).toHaveLength(2);
    expect(hasWatermarkHint(provider.calls[0]!)).toBe(true);
    expect(assistantText(result.assistantMessage)).toBe("水位收尾");
  });

  it("H4 日志补全：首步预检与兜底决策留痕（含 used/window/ratio）", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    try {
      const provider = new WatermarkToolLoopProvider();
      const bigUser = userMessage("x".repeat(8000));
      const tools = [
        { type: "function", function: { name: "dummy", description: "dummy", parameters: {} } },
      ];
      const base =
        getTokenCounter().countMessages([bigUser], { stripThinking: true }) +
        getTokenCounter().countTools(tools);

      await runWatermarkTurn(provider, {
        messages: [bigUser],
        contextWindow: Math.floor(base / 0.9), // 首步预检即撞顶
        maxSteps: 20,
      });

      const watermarkLogs = info.mock.calls.filter((c) => String(c[1]).includes("[watermark]"));
      expect(watermarkLogs.length).toBeGreaterThanOrEqual(2);
      expect(String(watermarkLogs[0]![1])).toContain("首步预检撞顶");
      expect(watermarkLogs[0]![0]).toMatchObject({ phase: "pre-check", agentId: "a" });
      expect(watermarkLogs[0]![0]).toHaveProperty("used");
      expect(watermarkLogs[0]![0]).toHaveProperty("window");
      expect(watermarkLogs[0]![0]).toHaveProperty("ratio");
      expect(watermarkLogs.some((c) => String(c[1]).includes("水位撞顶兜底"))).toBe(true);
    } finally {
      info.mockRestore();
    }
  });

  it("H4 日志有界：百步循环不逐步刷 info（每回合至多 4 条水位日志）", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    try {
      // 百步保险丝（无水位压力）：只 pre-check + fallback 两条 info，与步数无关
      const fuse = new WatermarkToolLoopProvider();
      await runWatermarkTurn(fuse); // 缺省 maxSteps=100
      expect(fuse.calls).toHaveLength(101);
      const fuseLogs = info.mock.calls.filter((c) => String(c[1]).includes("[watermark]"));
      expect(fuseLogs).toHaveLength(2);
      expect(fuseLogs.length).toBeLessThanOrEqual(4);
      expect(String(fuseLogs[0]![1])).toContain("首步预检通过");
      expect(String(fuseLogs[1]![1])).toContain("保险丝耗尽兜底");
      // 百步循环里没有逐步 info（未达提醒带只走 debug，不刷屏）
      expect(fuseLogs.some((c) => String(c[1]).includes("步后"))).toBe(false);

      // 完整水位瀑布：pre-check 通过 → 步后提醒 → 步后撞顶 → 兜底 = 4 条封顶。
      // 用递增 usage 驱动（8000→9100），避免大文本估算拖慢计数
      info.mockClear();
      class GrowingUsageWatermarkProvider implements LLMProvider {
        name = "growing-usage";
        readonly protocol: LLMProviderProtocol = "chat_completions";
        private call = 0;
        supportsModel() {
          return true;
        }
        async *chat(params: LLMChatParams): AsyncIterable<LLMEvent> {
          const call = this.call++;
          const hitSummaryHint = params.messages.some(
            (m) =>
              m.role === "system" &&
              m.content.some(
                (c) =>
                  c.type === "text" &&
                  (c.text.includes(CONTEXT_WATERMARK_SUMMARY_HINT) ||
                    c.text.includes(MAX_STEPS_SUMMARY_HINT)),
              ),
          );
          if (hitSummaryHint) {
            yield { type: "text.delta", delta: "水位收尾" };
          } else {
            yield { type: "tool.call", toolCallId: `tc_${call}`, name: "dummy", arguments: {} };
          }
          yield {
            type: "step.end",
            ...(call === 0
              ? { usage: { promptTokens: 7900, completionTokens: 100 } } // 0.8W → 提醒
              : call === 1
                ? { usage: { promptTokens: 9000, completionTokens: 100 } } // 0.91W → 撞顶
                : {}),
          };
        }
      }
      const provider = new GrowingUsageWatermarkProvider();
      const events: LLMEvent[] = [];
      await runTurn(
        {
          provider,
          model: "watermark-tool-loop",
          messages: [userMessage("x".repeat(8000))],
          tools: [
            { type: "function", function: { name: "dummy", description: "dummy", parameters: {} } },
          ],
          toolCtx: {
            agentId: "a",
            workspaceDir: "/tmp",
            tools: new Map([["dummy", dummyTool]]),
            approve: async () => true,
            emit: (e) => events.push(e),
          },
          contextWindow: 10000,
          maxSteps: 20,
        },
        (e) => events.push(e),
      );
      const waterfallLogs = info.mock.calls.filter((c) => String(c[1]).includes("[watermark]"));
      expect(waterfallLogs).toHaveLength(4);
      expect(waterfallLogs.map((c) => String(c[1]))).toEqual([
        "[watermark] 首步预检通过：正常进循环",
        "[watermark] 步后提醒：注入 70% 提醒后继续",
        "[watermark] 步后撞顶：跳出循环走水位兜底",
        "[watermark] 水位撞顶兜底：追加无工具总结",
      ]);
    } finally {
      info.mockRestore();
    }
  });
});

describe("P1-3 usage NaN 防护", () => {
  class NaNUsageToolProvider implements LLMProvider {
    name = "nan-usage-tool";
    calls = 0;
    supportsModel() {
      return true;
    }
    async *chat(params: LLMChatParams): AsyncIterable<LLMEvent> {
      this.calls++;
      const isSummary = params.messages.some(
        (m) =>
          m.role === "system" &&
          m.content.some(
            (c) =>
              c.type === "text" &&
              (c.text.includes(CONTEXT_WATERMARK_SUMMARY_HINT) ||
                c.text.includes(MAX_STEPS_SUMMARY_HINT)),
          ),
      );
      if (!isSummary) {
        yield {
          type: "tool.call",
          toolCallId: "tc_nan",
          name: "dummy",
          arguments: { value: "x".repeat(4000) },
        };
      } else {
        yield { type: "text.delta", delta: "收尾" };
      }
      yield {
        type: "step.end",
        ...(isSummary ? {} : { usage: { promptTokens: Number.NaN, completionTokens: Number.NaN } }),
      };
    }
  }

  it("usage 为 NaN 时 measured 不污染：水位按估算正常撞顶，不空转到保险丝", async () => {
    const provider = new NaNUsageToolProvider();
    const events: LLMEvent[] = [];
    const result = await runTurn(
      {
        provider,
        model: "nan-usage-tool",
        // 用户消息 + 工具定义估算 ~0.5W；工具结果追加后估算 >0.9W
        messages: [userMessage("x".repeat(2000))],
        tools: [
          { type: "function", function: { name: "dummy", description: "dummy", parameters: {} } },
        ],
        toolCtx: {
          agentId: "a",
          workspaceDir: "/tmp",
          tools: new Map([["dummy", dummyTool]]),
          approve: async () => true,
          emit: (e) => events.push(e),
        },
        contextWindow: 1000,
        maxSteps: 20,
      },
      (e) => events.push(e),
    );

    // NaN 被守卫丢弃 → 回退本地估算并正常撞顶；老实现 NaN 比值永不触发，
    // 会空转到 20 步保险丝（calls=21）
    expect(result.watermarkStopped).toBe(true);
    expect(Number.isFinite(result.watermarkUsed)).toBe(true);
    expect(provider.calls).toBeLessThan(5);
  });
});

describe("P1-2 空 assistant 不落盘", () => {
  class EmptyAssistantProvider implements LLMProvider {
    name = "empty-assistant";
    supportsModel() {
      return true;
    }
    async *chat(): AsyncIterable<LLMEvent> {
      // 异常形状：只发 step.end，无任何内容（历史上有网关空流/截断产生空 assistant）
      yield { type: "step.end" };
    }
  }

  it("空 content 的 assistant 消息不落盘不入历史（下轮不 400）；M5：回合不静默，产出兜底回复", async () => {
    const persisted: ChatMessage[][] = [];
    const events: LLMEvent[] = [];
    const result = await runTurn(
      {
        provider: new EmptyAssistantProvider(),
        model: "empty-assistant",
        messages: [userMessage("hi")],
        tools: [],
        toolCtx: {
          agentId: "a",
          workspaceDir: "/tmp",
          tools: new Map(),
          approve: async () => true,
          emit: (e) => events.push(e),
        },
        onStepAppended: async (msgs) => {
          persisted.push(msgs);
        },
      },
      (e) => events.push(e),
    );

    // M5：空内容 stop 视同异常收尾——兜底总结仍空则产出兜底回复，回合绝不静默
    expect(assistantText(result.assistantMessage)).toBe(MAX_STEPS_FALLBACK_REPLY);
    expect(result.appended).toHaveLength(1);
    expect(
      result.appended[0]!.content.some(
        (c) => c.type === "text" && c.text === MAX_STEPS_FALLBACK_REPLY,
      ),
    ).toBe(true);
    // P1-2 guard 不变：空 content 的 assistant 消息本身不落盘（persisted 只有兜底回复一条）
    expect(persisted.flat()).toHaveLength(1);
    expect(
      persisted.flat()[0]!.content.some(
        (c) => c.type === "text" && c.text === MAX_STEPS_FALLBACK_REPLY,
      ),
    ).toBe(true);
    expect(events.some((e) => e.type === "turn.end")).toBe(true);

    // 再跑一轮（模拟下一轮）：历史没有被空 assistant 污染，消息数保持原样
    const again = await runTurn(
      {
        provider: new EmptyAssistantProvider(),
        model: "empty-assistant",
        messages: [userMessage("hi")],
        tools: [],
        toolCtx: {
          agentId: "a",
          workspaceDir: "/tmp",
          tools: new Map(),
          approve: async () => true,
          emit: () => {},
        },
      },
      () => {},
    );
    expect(assistantText(again.assistantMessage)).toBe(MAX_STEPS_FALLBACK_REPLY);
    expect(again.appended).toHaveLength(1);
  });
});


describe("M4 单步工具结果合计上限", () => {
  it("单步 5 条工具结果合计超 40% 预算：超额部分逐条二次截断（保头尾），末位留占位", async () => {
    // 单条 ≈700 tokens（单条上限 800 之下，不触发单条截断）；5 条合计 ≈3500 > 1600 总量阀
    const counter = getTokenCounter();
    let chunk = "";
    while (counter.countText(chunk) < 700) chunk += "lorem ipsum dolor sit amet ";
    const bigTool: Tool = {
      name: "big",
      description: "returns ~700 tokens",
      parameters: z.object({}),
      accesses: [{ resource: "file", action: "read" }],
      async execute(): Promise<ToolResult> {
        return { success: true, output: chunk };
      },
    };
    class FiveToolProvider implements LLMProvider {
      name = "five-tool";
      private step = 0;
      captured: LLMChatParams | undefined;
      supportsModel() {
        return true;
      }
      async *chat(params: LLMChatParams): AsyncIterable<LLMEvent> {
        if (this.step++ === 0) {
          for (let i = 1; i <= 5; i++) {
            yield { type: "tool.call", toolCallId: `tc_${i}`, name: "big", arguments: {} };
          }
        } else {
          this.captured = params;
          yield { type: "text.delta", delta: "done" };
        }
        yield { type: "step.end" };
      }
    }

    const provider = new FiveToolProvider();
    // budget = 4000 → 单条上限 800（20%）、单步合计上限 1600（40%）
    const pipeline = new ContextPipeline({ maxContextTokens: 4000, reserveRatio: 0 });
    const result = await runTurn(
      {
        provider,
        model: "mock",
        messages: [userMessage("call big")],
        tools: [
          { type: "function", function: { name: "big", description: "big", parameters: {} } },
        ],
        toolCtx: {
          agentId: "a",
          workspaceDir: "/tmp",
          tools: new Map([["big", bigTool]]),
          approve: async () => true,
          emit: () => {},
        },
        contextPipeline: {
          pipeline,
          input: { agentId: "a", mindContext: "", sourceId: "s1" },
        },
      },
      () => {},
    );

    expect(assistantText(result.assistantMessage)).toBe("done");
    const toolMsgs = provider.captured!.messages.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(5);
    const texts = toolMsgs.map((m) => (m.content[0] as { type: "text"; text: string }).text);
    const serialized = JSON.stringify({ success: true, output: chunk });
    // 前两条完整保留（合计 ≈1430 ≤ 1600），未触发任何截断
    expect(texts[0]).toBe(serialized);
    expect(texts[1]).toBe(serialized);
    // 第三条起被总量阀截小：逐条二次截断（保头尾 + 省略标记）或末位占位
    expect(texts.slice(2).every((t) => counter.countText(t) < counter.countText(serialized))).toBe(
      true,
    );
    expect(
      texts.slice(2).some((t) => t.includes("省略") || t === TOOL_STEP_OVERFLOW_PLACEHOLDER),
    ).toBe(true);
    // 总量阀生效：5 条合计 ≤ 1600 + 占位容差（占位文本自身 tokens），远低于原始 ≈3500
    const total = texts.reduce((sum, t) => sum + counter.countText(t), 0);
    expect(total).toBeLessThanOrEqual(1600 + 2 * counter.countText(TOOL_STEP_OVERFLOW_PLACEHOLDER));
  });
});

describe("M5 空内容 stop 兜底", () => {
  /** 正常调用只发 step.end（空内容 stop）；带 M5 兜底提示的总结调用按行为产文本/空 */
  class EmptyStopProvider implements LLMProvider {
    name = "empty-stop";
    calls: LLMChatParams[] = [];
    constructor(private summaryBehavior: "text" | "empty" = "text") {}
    supportsModel() {
      return true;
    }
    async *chat(params: LLMChatParams): AsyncIterable<LLMEvent> {
      this.calls.push(params);
      const hasHint = params.messages.some(
        (m) =>
          m.role === "system" &&
          m.content.some((c) => c.type === "text" && c.text.includes(EMPTY_STOP_SUMMARY_HINT)),
      );
      if (hasHint && this.summaryBehavior === "text") {
        yield { type: "text.delta", delta: "补发的最终回复" };
      }
      yield { type: "step.end" };
    }
  }

  function runEmptyStopTurn(provider: EmptyStopProvider) {
    const events: LLMEvent[] = [];
    const done = runTurn(
      {
        provider,
        model: "empty-stop",
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
      (e) => events.push(e),
    );
    return { events, done };
  }

  it("空内容 stop 视同异常收尾：追加无工具总结调用，回合不静默", async () => {
    const provider = new EmptyStopProvider();
    const { events, done } = runEmptyStopTurn(provider);
    const result = await done;

    // 空 stop 步 + 1 次兜底总结调用
    expect(provider.calls).toHaveLength(2);
    const summaryParams = provider.calls[1]!;
    expect(summaryParams.tools).toBeUndefined();
    expect(
      summaryParams.messages.some(
        (m) =>
          m.role === "system" &&
          m.content.some((c) => c.type === "text" && c.text.includes(EMPTY_STOP_SUMMARY_HINT)),
      ),
    ).toBe(true);
    // 回合产出 assistant 文本，绝不静默
    expect(assistantText(result.assistantMessage)).toBe("补发的最终回复");
    expect(
      result.appended
        .at(-1)!
        .content.some((c) => c.type === "text" && c.text === "补发的最终回复"),
    ).toBe(true);
    expect(events.some((e) => e.type === "text.delta" && e.delta === "补发的最终回复")).toBe(true);
    expect(events.filter((e) => e.type === "turn.end")).toHaveLength(1);
  });

  it("兜底总结仍空：产出兜底回复（绝不静默）", async () => {
    const provider = new EmptyStopProvider("empty");
    const { events, done } = runEmptyStopTurn(provider);
    const result = await done;

    expect(provider.calls).toHaveLength(2);
    expect(assistantText(result.assistantMessage)).toBe(MAX_STEPS_FALLBACK_REPLY);
    expect(
      result.appended
        .at(-1)!
        .content.some((c) => c.type === "text" && c.text === MAX_STEPS_FALLBACK_REPLY),
    ).toBe(true);
    expect(events.some((e) => e.type === "text.delta" && e.delta === MAX_STEPS_FALLBACK_REPLY)).toBe(
      true,
    );
  });
});
