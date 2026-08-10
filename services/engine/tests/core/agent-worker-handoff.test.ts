/**
 * AgentWorker 换班移交接线：
 * ① 撞顶后 job.onEvent 补发 handoff.book（棒次/保险丝/水位/交接书正文+id），
 *    交接书经 onStepAppended 持久化（消息载体落历史）；
 * ② 续跑 job（handoffResume）→ 交接书置顶注入（pipeline 组装首条 system 消息）；
 * ③ normalizeHandoffMaxShifts 保险丝归一（缺省 5 / clamp 1-10 / 非法回退）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AgentWorker,
  HANDOFF_RESUME_GUIDE,
  HANDOFF_RESUME_SEPARATOR,
  normalizeHandoffMaxShifts,
  type Job,
} from "../../src/core/agent-worker.js";
import {
  HANDOFF_BOOK_PREFIX,
  HANDOFF_WRITING_GUIDANCE,
  CONTEXT_WATERMARK_SUMMARY_HINT,
} from "../../src/core/react/turn.js";
import type { Tool, ToolContext, ToolResult } from "../../src/tools/types.js";
import type { ChatMessage } from "@mindcloud/shared";
import type { LLMProvider, LLMChatParams, LLMEvent, LLMProviderProtocol } from "../../src/provider/types.js";
import type { IMessageRepository } from "../../src/memory/repositories/types.js";
import { restoreDataDir } from "../helpers/env.js";

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

/** 工具一步后 usage 撞顶；兜底总结产文本；瘦身写作调用产三分法文本 */
class WorkerWatermarkProvider implements LLMProvider {
  name = "worker-watermark";
  readonly protocol: LLMProviderProtocol = "chat_completions";
  calls = 0;
  supportsModel() {
    return true;
  }
  async *chat(params: LLMChatParams): AsyncIterable<LLMEvent> {
    void params;
    this.calls++;
    const has = (needle: string) =>
      params.messages.some(
        (m) =>
          m.role === "system" &&
          m.content.some((c) => c.type === "text" && c.text.includes(needle)),
      );
    if (has(HANDOFF_WRITING_GUIDANCE)) {
      yield {
        type: "text.delta",
        delta: "【任务目的】查资料\n【已完成】已取得 18 个话题目录\n【未来方向】读取 tp_001",
      };
    } else if (has(CONTEXT_WATERMARK_SUMMARY_HINT)) {
      yield { type: "text.delta", delta: "进展X；下一步Y" };
    } else {
      yield {
        type: "tool.call",
        toolCallId: "tc_1",
        name: "dummy",
        arguments: { value: "x" },
      };
    }
    yield { type: "step.end", usage: { promptTokens: 850, completionTokens: 100 } };
  }
}

/** 普通回复 + 记录首次调用参数（断言置顶注入） */
class CapturingProvider implements LLMProvider {
  name = "capturing";
  captured: LLMChatParams | undefined;
  supportsModel() {
    return true;
  }
  async *chat(params: LLMChatParams): AsyncIterable<LLMEvent> {
    this.captured = params;
    yield { type: "text.delta", delta: "ok" };
    yield { type: "step.end" };
  }
}

let tmpDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "worker-handoff-test-"));
  originalDataDir = process.env.CLOUDMIND_DATA_DIR;
  process.env.CLOUDMIND_DATA_DIR = tmpDir;
});

afterEach(async () => {
  restoreDataDir(originalDataDir);
  await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function runWorkerJob(
  provider: LLMProvider,
  opts: {
    maxContextTokens?: number;
    handoffMaxShifts?: number;
    handoffResume?: { shift: number; maxShifts: number; bookText: string };
    messageRepository?: Partial<IMessageRepository>;
  } = {},
): {
  events: LLMEvent[];
  appended: ChatMessage[];
  done: Promise<unknown>;
  worker: AgentWorker;
  capturedProvider?: CapturingProvider;
} {
  const events: LLMEvent[] = [];
  const appended: ChatMessage[] = [];
  const messageRepository: IMessageRepository = {
    append: vi.fn(async (msg: ChatMessage) => {
      appended.push(msg);
    }),
    listBySession: async () => [],
    ...opts.messageRepository,
  } as IMessageRepository;
  const worker = new AgentWorker({
    agentId: "agent-1",
    model: "mock",
    provider,
    tools: [dummyTool],
    workspaceDir: tmpDir,
    messageRepository,
    approve: () => true,
    maxContextTokens: opts.maxContextTokens,
    handoffMaxShifts: opts.handoffMaxShifts,
  });
  let resolveDone!: (err?: unknown) => void;
  const done = new Promise<unknown>((resolve) => {
    resolveDone = resolve;
  });
  const job: Job = {
    id: "job-1",
    messages: [userMessage("查资料")],
    sessionId: "s1",
    onEvent: (e) => events.push(e),
    onDone: (err) => resolveDone(err),
    ...(opts.handoffResume !== undefined ? { handoffResume: opts.handoffResume } : {}),
  };
  worker.enqueue(job);
  return { events, appended, done, worker };
}

describe("AgentWorker 换班移交接线", () => {
  it("撞顶补发 handoff.book 事件，交接书经 step 落盘进历史", async () => {
    const { events, appended, done } = runWorkerJob(new WorkerWatermarkProvider(), {
      maxContextTokens: 1000,
    });
    await done;
    await workerWaitForIdle(events);

    const bookEvent = events.find((e) => e.type === "handoff.book");
    expect(bookEvent).toBeDefined();
    if (bookEvent?.type !== "handoff.book") return;
    expect(bookEvent).toMatchObject({
      shift: 1,
      maxShifts: 5,
      window: 1000,
      bookText: expect.stringContaining(HANDOFF_BOOK_PREFIX),
    });
    expect(bookEvent.used).toBeGreaterThanOrEqual(950);

    // 消息载体：交接书 system 消息已落盘
    const book = appended.find(
      (m) => m.role === "system" && textOf(m).includes(HANDOFF_BOOK_PREFIX),
    );
    expect(book).toBeDefined();
    expect(book!.id).toBe(bookEvent.bookMessageId);
  });

  it("续跑 job：开工指引 + 分隔线 + 交接书原文置顶注入（pipeline 首条 system 消息），手传棒次生效", async () => {
    const provider = new CapturingProvider();
    const bookText =
      "[交接书] 换班移交（第 2/3 棒）\n- 已用上下文：950/1000 tokens（95%）。\n- 内容：\n【任务目的】查资料\n【已完成】已取得 18 个话题目录\n【未来方向】读取 tp_001";
    const { done } = runWorkerJob(provider, {
      handoffResume: { shift: 2, maxShifts: 3, bookText },
    });
    await done;
    await workerWaitForIdle([]);

    const first = provider.captured!.messages[0]!;
    expect(first.role).toBe("system");
    // 件4：固定开工指引 + 分隔线 + 交接书原文不丢
    expect(textOf(first)).toContain(HANDOFF_RESUME_GUIDE);
    expect(textOf(first)).toContain(HANDOFF_RESUME_SEPARATOR.trim());
    expect(textOf(first)).toContain(bookText);
    // 置顶：交接书在 SOUL（L1）之前
    expect(provider.captured!.messages[1]!.content.some((c) => c.type === "text" && c.text.includes("# SOUL"))).toBe(true);
  });

  it("normalizeHandoffMaxShifts：缺省 5、clamp 1-10、非法回退", () => {
    expect(normalizeHandoffMaxShifts(undefined)).toBe(5);
    expect(normalizeHandoffMaxShifts(0)).toBe(1);
    expect(normalizeHandoffMaxShifts(99)).toBe(10);
    expect(normalizeHandoffMaxShifts(2.4)).toBe(2);
    expect(normalizeHandoffMaxShifts(Number.NaN)).toBe(5);
  });
});

/** worker 队列排空（进程内轮询微任务即可，不需要墙钟等待） */
async function workerWaitForIdle(events: LLMEvent[]): Promise<void> {
  // onDone 已 settle 即队列处理完成；事件收集可能在 onDone 后仍有一个 tick
  await Promise.resolve();
  await Promise.resolve();
  void events;
}
