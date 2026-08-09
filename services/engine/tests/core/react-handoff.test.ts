/**
 * 水位撞顶 = 换班移交（交接书消息载体）：
 * ① 撞顶产出交接书（前缀/棒次/水位/进展摘要），落 messages 且经 onStepAppended 持久化；
 * ② 续跑棒次（shift/maxShifts 显式传入）盖对应棒次戳；
 * ③ 兜底总结失败时交接书仍产出（兜底回复文本入载体，换班不死）；
 * ④ 未撞顶不产出交接书。
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  runTurn,
  HANDOFF_BOOK_PREFIX,
  CONTEXT_WATERMARK_SUMMARY_HINT,
  CONTEXT_WATERMARK_FALLBACK_REPLY,
} from "../../src/core/react/turn.js";
import { MockLLMProvider } from "../../src/provider/llm.js";
import type { Tool, ToolContext, ToolResult } from "../../src/tools/types.js";
import type { ChatMessage } from "@mindcloud/shared";
import type { LLMProvider, LLMChatParams, LLMEvent, LLMProviderProtocol } from "../../src/provider/types.js";

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

function userMessage(text: string): ChatMessage {
  return {
    id: "1",
    role: "user",
    content: [{ type: "text", text }],
    createdAt: "2024-01-01",
  };
}

function textOf(message: ChatMessage): string {
  return message.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");
}

/** 工具一步后 usage 撞顶（950/1000）；兜底总结按配置产文本/抛错 */
class HandoffWatermarkProvider implements LLMProvider {
  name = "handoff-watermark";
  readonly protocol: LLMProviderProtocol = "chat_completions";
  calls = 0;
  constructor(private summaryBehavior: "text" | "throw" = "text") {}
  supportsModel() {
    return true;
  }
  async *chat(params: LLMChatParams): AsyncIterable<LLMEvent> {
    this.calls++;
    const hitHint = params.messages.some(
      (m) =>
        m.role === "system" &&
        m.content.some((c) => c.type === "text" && c.text.includes(CONTEXT_WATERMARK_SUMMARY_HINT)),
    );
    if (hitHint) {
      if (this.summaryBehavior === "throw") throw new Error("summary down");
      yield { type: "text.delta", delta: "进展X；下一步Y" };
    } else {
      yield {
        type: "tool.call",
        toolCallId: `tc_${this.calls}`,
        name: "dummy",
        arguments: { value: "x" },
      };
    }
    // 双口径取大：估算不含 usage 压力，实测 950/1000 直接撞顶
    yield { type: "step.end", usage: { promptTokens: 850, completionTokens: 100 } };
  }
}

function runWatermarkHandoff(
  provider: HandoffWatermarkProvider,
  opts: { handoff?: { shift: number; maxShifts: number }; onStepAppended?: (msgs: ChatMessage[]) => Promise<void> } = {},
) {
  return runTurn(
    {
      provider,
      model: "handoff-watermark",
      messages: [userMessage("查资料")],
      tools: [{ type: "function", function: { name: "dummy", description: "dummy", parameters: {} } }],
      toolCtx: {
        agentId: "a",
        workspaceDir: "/tmp",
        tools: new Map([["dummy", dummyTool]]),
        approve: async () => true,
        emit: () => {},
      },
      contextWindow: 1000,
      maxSteps: 20,
      handoff: opts.handoff,
      onStepAppended: opts.onStepAppended,
    },
    () => {},
  );
}

describe("水位撞顶换班移交（交接书消息载体）", () => {
  it("撞顶产出交接书：前缀/棒次/水位/进展摘要落 messages 并经 onStepAppended 持久化", async () => {
    const persisted: ChatMessage[][] = [];
    const result = await runWatermarkHandoff(new HandoffWatermarkProvider(), {
      onStepAppended: async (msgs) => {
        persisted.push(msgs);
      },
    });

    expect(result.watermarkStopped).toBe(true);
    expect(result.handoffBook).toBeDefined();
    const bookText = textOf(result.handoffBook!);
    expect(bookText.startsWith(HANDOFF_BOOK_PREFIX)).toBe(true);
    expect(bookText).toContain("第 1/5 棒");
    expect(bookText).toContain("950/1000");
    expect(bookText).toContain("进展X；下一步Y");

    // 消息载体：turn messages 尾部是交接书 system 消息；appended 语义不变（兜底产出为末条）
    expect(textOf(result.messages.at(-1)!)).toBe(bookText);
    expect(result.messages.at(-1)!.role).toBe("system");
    expect(textOf(result.appended.at(-1)!)).toBe("进展X；下一步Y");

    // 落盘回调包含交接书（撞顶即换班，历史留痕）
    const lastBatch = persisted.at(-1)!;
    expect(lastBatch.at(-1)!.role).toBe("system");
    expect(textOf(lastBatch.at(-1)!)).toBe(bookText);
  });

  it("续跑棒次：handoff 显式传入下一棒，交接书盖对应棒次戳", async () => {
    const result = await runWatermarkHandoff(new HandoffWatermarkProvider(), {
      handoff: { shift: 2, maxShifts: 3 },
    });
    expect(result.handoffBook).toBeDefined();
    expect(textOf(result.handoffBook!)).toContain("第 2/3 棒");
    expect(result.handoffShift).toBe(2);
    expect(result.handoffMaxShifts).toBe(3);
  });

  it("兜底总结失败/空文本：交接书仍产出（兜底回复文本入载体，换班不死）", async () => {
    const result = await runWatermarkHandoff(new HandoffWatermarkProvider("throw"));
    expect(result.watermarkStopped).toBe(true);
    expect(result.handoffBook).toBeDefined();
    expect(textOf(result.handoffBook!)).toContain(CONTEXT_WATERMARK_FALLBACK_REPLY);
  });

  it("未撞顶不产出交接书", async () => {
    const events: LLMEvent[] = [];
    const result = await runTurn(
      {
        provider: new MockLLMProvider(),
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
      (e) => events.push(e),
    );
    expect(result.watermarkStopped).toBe(false);
    expect(result.handoffBook).toBeUndefined();
  });
});
