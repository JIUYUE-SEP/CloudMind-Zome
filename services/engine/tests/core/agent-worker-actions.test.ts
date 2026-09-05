import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentWorker } from "../../src/core/agent-worker.js";
import { mindService } from "../../src/plugins/mind/index.js";
import { computeService } from "../../src/plugins/compute/index.js";
import { MockLLMProvider } from "../../src/provider/llm.js";
import { ActionRepository } from "../../src/memory/repositories/action.js";
import { getAgentDir } from "../../src/config/paths.js";
import type { IActionRepository, IMessageRepository } from "../../src/memory/repositories/types.js";
import type { Tool, ToolContext, ToolResult } from "../../src/tools/types.js";
import type { ChatMessage } from "@cloudmind/shared";
import type { LLMEvent } from "../../src/provider/types.js";
import { restoreDataDir } from "../helpers/env.js";

// H1 生产链路回归：worker toolCtx 装配注入 recordAction → runToolCallBatch 每条
// 调用完成即落档 → actions.jsonl 有记录（修复前 ActionRepository.append 全仓零
// 调用，GET /actions/:agentId 恒空）。走 AgentWorker → turn → step →
// runToolCallBatch 真实装配路径兜底防回归（同 agent-worker-builtin-tools.test.ts）。
const echoTool: Tool = {
  name: "echo",
  description: "echo tool",
  parameters: z.object({ command: z.string() }),
  accesses: [],
  async execute(ctx: ToolContext, args: unknown): Promise<ToolResult> {
    void ctx;
    return { success: true, output: `echo ${(args as { command: string }).command}` };
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

describe("AgentWorker 工具调用落档（H1：actions.jsonl 写入方）", () => {
  // actions.jsonl 落数据目录：隔离到临时目录，同 agent-worker-builtin-tools.test.ts
  let tmpDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "worker-actions-"));
    originalDataDir = process.env.CLOUDMIND_DATA_DIR;
    process.env.CLOUDMIND_DATA_DIR = tmpDir;
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    restoreDataDir(originalDataDir);
  });

  function makeWorker(
    provider: MockLLMProvider,
    actionRepository?: IActionRepository,
  ): AgentWorker {
    return new AgentWorker({
      agentId: "agent-1",
      model: "mock",
      provider,
      tools: [echoTool],
      workspaceDir: tmpDir,
      messageRepository: {
        append: async () => {},
        listBySession: async () => [],
      } as unknown as IMessageRepository,
      ...(actionRepository ? { actionRepository } : {}),
      approve: async () => true,
      mind: mindService,
      compute: computeService,
    });
  }

  it("含工具调用的回合：actions.jsonl 落一条记录，字段正确、参数摘要已截断", async () => {
    const provider = new MockLLMProvider();
    provider.setNextToolCalls([
      { toolCallId: "tc_1", name: "echo", arguments: { command: "x".repeat(1000) } },
    ]);
    const worker = makeWorker(provider, new ActionRepository("agent-1"));
    const onDone = vi.fn();
    worker.enqueue({ id: "j1", messages: [userMessage("跑一下")], onEvent: () => {}, onDone });

    await vi.waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(onDone).toHaveBeenCalledWith(undefined);

    // 落档是 fire-and-forget：轮询等 actions.jsonl 出现一条记录
    const file = path.join(getAgentDir("agent-1"), "actions.jsonl");
    let lines: string[] = [];
    await vi.waitFor(async () => {
      lines = (await fs.readFile(file, "utf-8")).trim().split("\n").filter(Boolean);
      expect(lines).toHaveLength(1);
    });
    const record = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(record).toMatchObject({ id: "tc_1", status: "completed" });
    // 参数摘要与审批审计同口径：command 截 500 + 截断标注，1000 字符原文不落盘
    expect(record.description).toBe(`echo(command=${"x".repeat(500)}…(1000 chars))`);
    expect(Number.isNaN(Date.parse(record.createdAt as string))).toBe(false);
    expect(record.updatedAt).toBe(record.createdAt);
  });

  it("落档失败（append 拒绝）：回合与工具结果不受影响（fire-and-forget + .catch）", async () => {
    const provider = new MockLLMProvider();
    provider.setNextToolCalls([{ toolCallId: "tc_1", name: "echo", arguments: { command: "hi" } }]);
    const brokenRepository = {
      append: async () => {
        throw new Error("disk full");
      },
    } as unknown as IActionRepository;
    const worker = makeWorker(provider, brokenRepository);
    const events: LLMEvent[] = [];
    const onDone = vi.fn();
    worker.enqueue({
      id: "j1",
      messages: [userMessage("跑一下")],
      onEvent: (e) => events.push(e),
      onDone,
    });

    await vi.waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(onDone).toHaveBeenCalledWith(undefined);

    const toolResult = events.find((e) => e.type === "tool.result") as
      | { output: { success: boolean; output?: string } }
      | undefined;
    expect(toolResult?.output.success).toBe(true);
    expect(toolResult?.output.output).toBe("echo hi");
  });

  it("未注入 actionRepository：不落档（actions.jsonl 不存在，保持缺省语义）", async () => {
    const provider = new MockLLMProvider();
    provider.setNextToolCalls([{ toolCallId: "tc_1", name: "echo", arguments: { command: "hi" } }]);
    const worker = makeWorker(provider);
    const onDone = vi.fn();
    worker.enqueue({ id: "j1", messages: [userMessage("跑一下")], onEvent: () => {}, onDone });

    await vi.waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(onDone).toHaveBeenCalledWith(undefined);

    const file = path.join(getAgentDir("agent-1"), "actions.jsonl");
    await expect(fs.access(file)).rejects.toThrow();
  });
});
