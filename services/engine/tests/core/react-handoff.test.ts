/**
 * 水位撞顶 = 换班移交（交接书消息载体 + 套娃空转根治四件套）：
 * ① 撞顶产出交接书（前缀/棒次/水位/三分法内容/足迹），落 messages 且经 onStepAppended 持久化；
 * ② 瘦身写作调用：system 指引 + user 材料包四样（任务原消息/上一棒交接书/本棒足迹/本棒回顾），
 *    不携带全量历史；任务原消息截 2000 字符；
 * ③ 写作调用失败/空文本 → 交接书内容=兜底总结文本（现状行为保底）；
 * ④ 足迹机械附：多次工具调用含 name+参数；无工具调用省略；单条 80/总长 500 截断；
 * ⑤ 续跑棒次（shift/maxShifts 显式传入）盖对应棒次戳；未撞顶不产出交接书。
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  runTurn,
  HANDOFF_BOOK_PREFIX,
  HANDOFF_WRITING_GUIDANCE,
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

/** 瘦身写作调用正常产出（三分法内容） */
const WRITTEN_BOOK =
  "【任务目的】查资料\n" +
  "【已完成】已取得 18 个话题目录（tp_001）；确认 tp_099 无关\n" +
  "【未来方向】读取 tp_001 继续整理";

/**
 * 换班移交四件套夹具：普通步发工具（可多步/带参），撞顶兜底调用按行为产文本/抛错/空文本，
 * 瘦身写作调用按行为产三分法文本/抛错/空文本；记录写作调用与总结调用参数。
 */
class HandoffWatermarkProvider implements LLMProvider {
  name = "handoff-watermark";
  readonly protocol: LLMProviderProtocol = "chat_completions";
  calls = 0;
  writeParams: LLMChatParams[] = [];
  summaryParams: LLMChatParams[] = [];
  private toolStepsDone = 0;
  constructor(
    private opts: {
      summaryBehavior?: "text" | "throw" | "empty";
      writeBehavior?: "text" | "throw" | "empty";
      toolSteps?: number;
      toolArgs?: Array<Record<string, unknown>>;
      hitUsage?: { promptTokens: number; completionTokens: number };
      normalUsage?: { promptTokens: number; completionTokens: number };
    } = {},
  ) {}
  supportsModel() {
    return true;
  }
  async *chat(params: LLMChatParams): AsyncIterable<LLMEvent> {
    this.calls++;
    const has = (needle: string) =>
      params.messages.some(
        (m) =>
          m.role === "system" &&
          m.content.some((c) => c.type === "text" && c.text.includes(needle)),
      );
    if (has(HANDOFF_WRITING_GUIDANCE)) {
      this.writeParams.push(params);
      if (this.opts.writeBehavior === "throw") throw new Error("write down");
      if (this.opts.writeBehavior === "empty") {
        yield { type: "step.end" };
        return;
      }
      yield { type: "text.delta", delta: WRITTEN_BOOK };
      yield { type: "step.end" };
      return;
    }
    if (has(CONTEXT_WATERMARK_SUMMARY_HINT)) {
      this.summaryParams.push(params);
      if (this.opts.summaryBehavior === "throw") throw new Error("summary down");
      if (this.opts.summaryBehavior === "empty") {
        yield { type: "step.end" };
        return;
      }
      yield { type: "text.delta", delta: "进展X；下一步Y" };
      yield { type: "step.end" };
      return;
    }
    const stepIdx = this.toolStepsDone++;
    const args =
      Array.isArray(this.opts.toolArgs)
        ? (this.opts.toolArgs[stepIdx] ?? { value: "x" })
        : (this.opts.toolArgs ?? { value: "x" });
    yield {
      type: "tool.call",
      toolCallId: `tc_${this.calls}`,
      name: "dummy",
      arguments: args,
    };
    const toolSteps = this.opts.toolSteps ?? 1;
    yield {
      type: "step.end",
      usage:
        stepIdx + 1 >= toolSteps
          ? (this.opts.hitUsage ?? { promptTokens: 850, completionTokens: 100 })
          : (this.opts.normalUsage ?? { promptTokens: 100, completionTokens: 10 }),
    };
  }
}

function runWatermarkHandoff(
  provider: HandoffWatermarkProvider,
  opts: {
    handoff?: { shift: number; maxShifts: number };
    onStepAppended?: (msgs: ChatMessage[]) => Promise<void>;
    messages?: ChatMessage[];
    contextWindow?: number;
    maxSteps?: number;
  } = {},
) {
  return runTurn(
    {
      provider,
      model: "handoff-watermark",
      messages: opts.messages ?? [userMessage("查资料")],
      tools: [{ type: "function", function: { name: "dummy", description: "dummy", parameters: {} } }],
      toolCtx: {
        agentId: "a",
        workspaceDir: "/tmp",
        tools: new Map([["dummy", dummyTool]]),
        approve: async () => true,
        emit: () => {},
      },
      contextWindow: opts.contextWindow ?? 1000,
      maxSteps: opts.maxSteps ?? 20,
      handoff: opts.handoff,
      onStepAppended: opts.onStepAppended,
    },
    () => {},
  );
}

function bookFootprintLine(bookText: string): string | undefined {
  return bookText.match(/- 本棒足迹：([^\n]*)/)?.[1];
}

describe("水位撞顶换班移交（交接书消息载体）", () => {
  it("撞顶产出交接书：棒次戳/水位/足迹/三分法内容落 messages 并经 onStepAppended 持久化", async () => {
    const persisted: ChatMessage[][] = [];
    const provider = new HandoffWatermarkProvider();
    const result = await runWatermarkHandoff(provider, {
      onStepAppended: async (msgs) => {
        persisted.push(msgs);
      },
    });

    expect(result.watermarkStopped).toBe(true);
    expect(result.handoffBook).toBeDefined();
    // 工具步 + 兜底总结 + 瘦身写作 = 3 次 LLM 调用（既有水位用例适配）
    expect(provider.calls).toBe(3);
    const bookText = textOf(result.handoffBook!);
    expect(bookText.startsWith(HANDOFF_BOOK_PREFIX)).toBe(true);
    expect(bookText).toContain("第 1/5 棒");
    expect(bookText).toContain("950/1000");
    expect(bookText).toContain(`- 本棒足迹：dummy({"value":"x"})`);
    expect(bookText).toContain("- 内容：");
    expect(bookText).toContain(WRITTEN_BOOK);

    // 消息载体：turn messages 尾部是交接书 system 消息；appended 语义不变（兜底产出为末条）
    expect(textOf(result.messages.at(-1)!)).toBe(bookText);
    expect(result.messages.at(-1)!.role).toBe("system");
    expect(textOf(result.appended.at(-1)!)).toBe("进展X；下一步Y");

    // 落盘回调包含交接书（撞顶即换班，历史留痕）
    const lastBatch = persisted.at(-1)!;
    expect(lastBatch.at(-1)!.role).toBe("system");
    expect(textOf(lastBatch.at(-1)!)).toBe(bookText);
  });

  it("makeHandoffBook 新模板结构：已用上下文/足迹/内容三段按序出现", async () => {
    const result = await runWatermarkHandoff(new HandoffWatermarkProvider());
    const bookText = textOf(result.handoffBook!);
    const iUsed = bookText.indexOf("- 已用上下文：950/1000 tokens（95%）。");
    const iFoot = bookText.indexOf("- 本棒足迹：");
    const iContent = bookText.indexOf("- 内容：");
    expect(iUsed).toBeGreaterThanOrEqual(0);
    expect(iFoot).toBeGreaterThan(iUsed);
    expect(iContent).toBeGreaterThan(iFoot);
    expect(bookText.slice(iContent + "- 内容：".length).trim()).toContain("【任务目的】");
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

  it("瘦身写作调用：system 指引 + user 材料包四样，不携带全量历史", async () => {
    const prevBook: ChatMessage = {
      id: "book1",
      role: "system",
      content: [
        {
          type: "text",
          text:
            "[交接书] 上下文水位撞顶，本轮任务未完成，换班移交（第 1/5 棒）。\n" +
            "- 已用上下文：950/1000 tokens（95%）。\n" +
            "- 内容：\n【任务目的】整理话题目录\n【已完成】已取得 18 个话题目录\n【未来方向】读取 tp_001",
        },
      ],
      createdAt: "2024-01-01",
    };
    const provider = new HandoffWatermarkProvider();
    const result = await runWatermarkHandoff(provider, {
      messages: [userMessage("任务：整理话题目录"), prevBook, userMessage("历史噪音-甲"), userMessage("历史噪音-乙")],
    });

    expect(result.handoffBook).toBeDefined();
    expect(provider.writeParams).toHaveLength(1);
    const writeMessages = provider.writeParams[0]!.messages;
    // 只有两段：system 指引 + user 材料包（无全量历史）
    expect(writeMessages).toHaveLength(2);
    expect(writeMessages[0]!.role).toBe("system");
    expect(textOf(writeMessages[0]!)).toContain(HANDOFF_WRITING_GUIDANCE);
    expect(textOf(writeMessages[0]!)).toContain("【任务目的】");
    expect(textOf(writeMessages[0]!)).toContain("【未来方向】");
    const material = textOf(writeMessages[1]!);
    // 材料包四样齐备
    expect(material).toContain("【任务原消息】");
    expect(material).toContain("任务：整理话题目录");
    expect(material).toContain("【上一棒交接书】");
    expect(material).toContain("[交接书] 上下文水位撞顶");
    expect(material).toContain("【本棒足迹】");
    expect(material).toContain(`dummy({"value":"x"})`);
    expect(material).toContain("【本棒回顾】");
    expect(material).toContain("进展X；下一步Y");
    // 历史噪音不进写作调用（瘦身：上下文仅几千 token 而非全量历史）
    expect(material).not.toContain("历史噪音");
  });

  it("任务原消息截 2000 字符：超长任务文本只进截断后的片段", async () => {
    const provider = new HandoffWatermarkProvider();
    await runWatermarkHandoff(provider, {
      messages: [userMessage(`任务：${"x".repeat(2500)}`)],
      contextWindow: 1, // 首步预检即撞顶：本回合无工具调用
    });
    const material = textOf(provider.writeParams[0]!.messages[1]!);
    const taskSection = material.split("【任务原消息】")[1]!.split("【本棒回顾】")[0]!.trim();
    expect(taskSection.length).toBe(2000);
  });

  it("写作调用失败/空文本降级：交接书内容=兜底总结文本（现状行为保底）", async () => {
    for (const writeBehavior of ["throw", "empty"] as const) {
      const provider = new HandoffWatermarkProvider({ writeBehavior });
      const result = await runWatermarkHandoff(provider);
      expect(result.handoffBook).toBeDefined();
      const bookText = textOf(result.handoffBook!);
      expect(bookText).toContain("进展X；下一步Y");
      expect(bookText).not.toContain("【任务目的】");
    }
  });

  it("兜底总结失败/空文本 + 写作调用失败：交接书仍产出（兜底回复文本入载体，换班不死）", async () => {
    for (const summaryBehavior of ["throw", "empty"] as const) {
      const provider = new HandoffWatermarkProvider({ summaryBehavior, writeBehavior: "throw" });
      const result = await runWatermarkHandoff(provider);
      expect(result.watermarkStopped).toBe(true);
      expect(result.handoffBook).toBeDefined();
      expect(textOf(result.handoffBook!)).toContain(CONTEXT_WATERMARK_FALLBACK_REPLY);
    }
  });

  it("足迹机械附：多次工具调用含 name+参数；无工具调用省略", async () => {
    const multi = await runWatermarkHandoff(
      new HandoffWatermarkProvider({
        toolSteps: 2,
        toolArgs: [{ value: "a" }, { value: "b" }],
      }),
    );
    expect(bookFootprintLine(textOf(multi.handoffBook!))).toBe(
      `dummy({"value":"a"})；dummy({"value":"b"})`,
    );

    const noTool = await runWatermarkHandoff(new HandoffWatermarkProvider(), {
      contextWindow: 1, // 首步预检即撞顶：本回合无工具调用
    });
    expect(textOf(noTool.handoffBook!)).not.toContain("本棒足迹：");
  });

  it("足迹截断：单条 80 字符/总长 500 字符", async () => {
    // 单条超长参数 → 截到 80
    const one = await runWatermarkHandoff(
      new HandoffWatermarkProvider({
        toolArgs: [{ value: "x".repeat(200) }],
      }),
    );
    const oneLine = bookFootprintLine(textOf(one.handoffBook!))!;
    expect(oneLine.length).toBeLessThanOrEqual(80);
    expect(oneLine.endsWith("…")).toBe(true);

    // 7 条 80 字符足迹（560）→ 总长截到 500
    const many = await runWatermarkHandoff(
      new HandoffWatermarkProvider({
        toolSteps: 7,
        toolArgs: [
          { value: "a".repeat(100) },
          { value: "b".repeat(100) },
          { value: "c".repeat(100) },
          { value: "d".repeat(100) },
          { value: "e".repeat(100) },
          { value: "f".repeat(100) },
          { value: "g".repeat(100) },
        ],
      }),
    );
    const manyLine = bookFootprintLine(textOf(many.handoffBook!))!;
    expect(manyLine.length).toBeLessThanOrEqual(500);
    expect(manyLine.endsWith("…")).toBe(true);
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
