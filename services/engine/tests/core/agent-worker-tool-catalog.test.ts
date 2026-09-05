import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { AgentWorker } from "../../src/core/agent-worker.js";
import { mindService } from "../../src/plugins/mind/index.js";
import { computeService } from "../../src/plugins/compute/index.js";
import { loadTool } from "../../src/tools/builtin/load_tool.js";
import { listFilesTool } from "../../src/tools/builtin/list_files.js";
import { ContextPipeline } from "../../src/context/pipeline.js";
import { SECURITY_GUIDELINE } from "../../src/context/security-guideline.js";
import type { TokenCounter } from "../../src/context/token-counter.js";
import type { LLMProvider, LLMChatParams, LLMEvent } from "../../src/provider/types.js";
import type { Tool } from "../../src/tools/types.js";
import type { ChatMessage } from "@cloudmind/shared";
import type { IMessageRepository } from "../../src/memory/repositories/types.js";
import { restoreDataDir } from "../helpers/env.js";

/** 确定性假计数器（1 字符 = 1 token）：预算交互用例精确控制（同 pipeline.test.ts 范式） */
class FakeCounter implements TokenCounter {
  countText(text: string): number {
    return text.length;
  }
  countMessages(messages: ChatMessage[]): number {
    let total = 0;
    for (const m of messages) {
      total += 4;
      for (const c of m.content) total += c.type === "text" ? c.text.length : c.think.length;
      if (m.toolCalls) total += JSON.stringify(m.toolCalls).length;
    }
    return total;
  }
  countTools(tools: unknown[]): number {
    return JSON.stringify(tools).length;
  }
}

/** 记录每次 chat 调用参数（L1 内容 / 工具表逐步断言用） */
class RecordingProvider implements LLMProvider {
  name = "recording";
  calls: LLMChatParams[] = [];
  private step = 0;
  constructor(private readonly loadOnFirstStep: boolean) {}
  supportsModel() {
    return true;
  }
  async *chat(params: LLMChatParams): AsyncIterable<LLMEvent> {
    this.calls.push(params);
    if (this.loadOnFirstStep && this.step === 0) {
      this.step++;
      yield {
        type: "tool.call",
        toolCallId: "tc_1",
        name: "load_tool",
        arguments: { names: ["mcp__srv__t1"] },
      };
    } else {
      yield { type: "text.delta", delta: "done" };
    }
    yield { type: "step.end" };
  }
}

function makeDynamicTool(name: string): Tool {
  return {
    name,
    description: `${name} 的描述。第二句不进口录。`,
    parameters: z.object({ value: z.string().optional() }),
    accesses: [{ resource: "network", action: "read" }],
    async execute() {
      return { success: true, output: "ok" };
    },
  };
}

function textOf(message: ChatMessage): string {
  return message.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
}

function toolNamesOf(params: LLMChatParams): string[] {
  return ((params.tools ?? []) as { function: { name: string } }[]).map((t) => t.function.name);
}

/** 队列剧本 provider：每次 chat 消费一个动作（文本 or load_tool 调用），跨 job 连续消费 */
class ScriptedProvider implements LLMProvider {
  name = "scripted";
  calls: LLMChatParams[] = [];
  private i = 0;
  constructor(private readonly script: Array<"text" | { load: string[] }>) {}
  supportsModel() {
    return true;
  }
  async *chat(params: LLMChatParams): AsyncIterable<LLMEvent> {
    this.calls.push(params);
    const action = this.script[Math.min(this.i, this.script.length - 1)];
    this.i++;
    if (typeof action === "object") {
      yield { type: "tool.call", toolCallId: `tc_${this.i}`, name: "load_tool", arguments: { names: action.load } };
    } else {
      yield { type: "text.delta", delta: "done" };
    }
    yield { type: "step.end" };
  }
}

describe("AgentWorker 按需工具目录（spec 决策 1/2/4）", () => {
  let tmpDir: string;
  let workspaceDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "worker-tool-catalog-"));
    workspaceDir = path.join(tmpDir, "workspace");
    await fs.mkdir(workspaceDir);
    originalDataDir = process.env.CLOUDMIND_DATA_DIR;
    process.env.CLOUDMIND_DATA_DIR = tmpDir;
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    restoreDataDir(originalDataDir);
  });

  function makeWorker(provider: LLMProvider, tools: Tool[], contextPipeline?: ContextPipeline): AgentWorker {
    return new AgentWorker({
      agentId: "agent-1",
      model: "mock",
      provider,
      tools,
      workspaceDir,
      messageRepository: {
        append: async () => {},
        listBySession: async () => [],
      } as unknown as IMessageRepository,
      approve: async () => true,
      mind: mindService,
      compute: computeService,
      ...(contextPipeline ? { contextPipeline } : {}),
    });
  }

  async function runJob(worker: AgentWorker, id = "j1"): Promise<LLMEvent[]> {
    const events: LLMEvent[] = [];
    const onDone = vi.fn();
    const userMsg: ChatMessage = {
      id: "1",
      role: "user",
      content: [{ type: "text", text: "hi" }],
      createdAt: "2024-01-01",
    };
    worker.enqueue({ id, messages: [userMsg], onEvent: (e) => events.push(e), onDone });
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(onDone).toHaveBeenCalledWith(undefined);
    return events;
  }

  it("恒等：无动态工具的 agent——L1 无「按需工具」段，工具表 = 全量内置", async () => {
    const provider = new RecordingProvider(false);
    const worker = makeWorker(provider, [listFilesTool, loadTool]);
    await runJob(worker);

    expect(provider.calls.length).toBeGreaterThan(0);
    const first = provider.calls[0]!;
    expect(textOf(first.messages[0]!)).not.toContain("按需工具");
    expect(toolNamesOf(first)).toEqual(["list_files", "load_tool"]);
  });

  it("有动态工具：L1 目录段格式 + DISCIPLINE 文案；首轮工具表不含未取回动态工具", async () => {
    const provider = new RecordingProvider(false);
    const worker = makeWorker(provider, [loadTool, makeDynamicTool("mcp__srv__t1")]);
    await runJob(worker);

    const first = provider.calls[0]!;
    const l1 = textOf(first.messages[0]!);
    expect(l1).toContain("# 按需工具");
    expect(l1).toContain("load_tool 按限定名取回");
    expect(l1).toContain("- mcp__srv__t1 — mcp__srv__t1 的描述。");
    expect(l1).not.toContain("第二句不进口录");
    // 未取回：schema 零成本——工具表只有 load_tool
    expect(toolNamesOf(first)).toEqual(["load_tool"]);
  });

  it("轮内生效 + session 粘性：step1 取回 → step2 工具表含 schema；下一轮仍在", async () => {
    const provider = new RecordingProvider(true);
    const worker = makeWorker(provider, [loadTool, makeDynamicTool("mcp__srv__t1")]);
    const events = await runJob(worker);

    // load_tool 执行成功（整壳 ToolResult：{success, output}）
    const toolResult = events.find((e) => e.type === "tool.result") as
      | { output: { success: boolean } }
      | undefined;
    expect(toolResult?.output.success).toBe(true);

    expect(provider.calls).toHaveLength(2);
    // step1（取回前）：无 mcp schema；step2（步前重读）：含 mcp schema——
    // 增量经 stepInput.tools 传导，水位 contextUsedTokens 同变量自动计入
    expect(toolNamesOf(provider.calls[0]!)).not.toContain("mcp__srv__t1");
    expect(toolNamesOf(provider.calls[1]!)).toContain("mcp__srv__t1");

    // session 粘性：第二轮未再取回，schema 仍在工具表
    await runJob(worker, "j2");
    expect(provider.calls).toHaveLength(3);
    expect(toolNamesOf(provider.calls[2]!)).toContain("mcp__srv__t1");
    // 已取回工具离开目录：第二轮 L1 无目录段（catalog 空）
    expect(textOf(provider.calls[2]!.messages[0]!)).not.toContain("按需工具");
  });

  it("降级×取回交互（review High）：assemble 裁掉的 loaded ext 不被 refresh 复活；显式重复取回后下一步合法复活", async () => {
    // SOUL 播种极简内容控制固定成本（默认模板太长会吃掉预算余量）
    await fs.mkdir(path.join(tmpDir, "agents", "agent-1"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "agents", "agent-1", "SOUL.md"), "x");

    const fat = (name: string): Tool => ({
      name,
      description: "x".repeat(300),
      parameters: z.object({ value: z.string().optional() }),
      accesses: [{ resource: "network", action: "read" }],
      async execute() {
        return { success: true, output: "ok" };
      },
    });
    const t1 = fat("mcp__fat__t1");
    const t2 = fat("mcp__fat__t2");

    // 预算动态计算（不写死数字）：halve 后（core + 幸存 t2）存活，full（含 t1）超
    const counter = new FakeCounter();
    const desc = (t: Tool) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: zodToJsonSchema(t.parameters) },
    });
    const halvedTokens = counter.countTools([desc(loadTool), desc(t2)]);
    const fullTokens = counter.countTools([desc(loadTool), desc(t2), desc(t1)]);
    // 预算动态计算（不写死数字）：total = fixed(L1：SOUL"x"+SECURITY_GUIDELINE 的
    // system 消息) + l3(user"hi") + tools——halved 存活（+10 余量）、full 超
    const fixedTokens = 4 + ("x\n\n" + SECURITY_GUIDELINE).length;
    const l3Tokens = 4 + "hi".length;
    const budget = halvedTokens + fixedTokens + l3Tokens + 10;
    expect(fullTokens + fixedTokens + l3Tokens).toBeGreaterThan(budget);
    const pipeline = new ContextPipeline({ maxContextTokens: budget, reserveRatio: 0 }, counter);

    const provider = new ScriptedProvider([
      { load: ["mcp__fat__t1", "mcp__fat__t2"] }, // job1 step1：取回两件
      "text", // job1 step2
      { load: ["mcp__fat__t1"] }, // job2 step1：显式重复取回被裁的 t1
      "text", // job2 step2
    ]);
    const worker = makeWorker(provider, [loadTool, t1, t2], pipeline);

    // job1：取回两件（MRU：t2 在前）
    await runJob(worker);
    expect(toolNamesOf(provider.calls[1]!)).toContain("mcp__fat__t1");

    // job2：assemble 撞预算 → l6ext:halve 保前部（t2），t1 被裁——
    // 撞预算的 step 的 tools：不含被裁件、含幸存件（refresh 不得冲掉裁剪）
    await runJob(worker, "j2");
    const trimmedStep = toolNamesOf(provider.calls[2]!);
    expect(trimmedStep).toContain("load_tool");
    expect(trimmedStep).toContain("mcp__fat__t2");
    expect(trimmedStep).not.toContain("mcp__fat__t1");

    // job2 step1 显式重复取回 t1 → 下一步复活（机制本意：模型明着要就还给它）
    const revivedStep = toolNamesOf(provider.calls[3]!);
    expect(revivedStep).toContain("mcp__fat__t1");
    expect(revivedStep).toContain("mcp__fat__t2");
  });
});
