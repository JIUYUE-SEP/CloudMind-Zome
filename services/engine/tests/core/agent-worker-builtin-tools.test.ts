import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentWorker } from "../../src/core/agent-worker.js";
import { mindService } from "../../src/plugins/mind/index.js";
import { computeService } from "../../src/plugins/compute/index.js";
import { MockLLMProvider } from "../../src/provider/llm.js";
import { listFilesTool } from "../../src/tools/builtin/list_files.js";
import type { LLMEvent } from "../../src/provider/types.js";
import type { ChatMessage } from "@cloudmind/shared";
import type { IMessageRepository } from "../../src/memory/repositories/types.js";
import { restoreDataDir } from "../helpers/env.js";

// 生产链路回归：装配点（agent-worker 构造 toolCtx）只传 workspaceDir、
// 不传 projectRoot，list_files/edit_file/run_command 必须回落 workspaceDir
// 正常工作——曾因强制要求 projectRoot 而在生产 100% 报
// "No project root configured"。本用例走 AgentWorker → step →
// runToolCallBatch → 工具 的真实装配路径兜底防回归。
describe("AgentWorker 内置工具生产链路（toolCtx 无 projectRoot）", () => {
  // SOUL.md 从数据目录读取：隔离到临时目录，同 agent-worker.test.ts
  let tmpDir: string;
  let workspaceDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "worker-builtin-tools-"));
    workspaceDir = path.join(tmpDir, "workspace");
    await fs.mkdir(workspaceDir);
    originalDataDir = process.env.CLOUDMIND_DATA_DIR;
    process.env.CLOUDMIND_DATA_DIR = tmpDir;
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    restoreDataDir(originalDataDir);
  });

  it("list_files 经真实装配成功执行并列出 workspaceDir 内容", async () => {
    await fs.writeFile(path.join(workspaceDir, "hello.txt"), "hi");

    const provider = new MockLLMProvider();
    provider.setNextToolCalls([
      { toolCallId: "tc_1", name: "list_files", arguments: { path: "." } },
    ]);
    const worker = new AgentWorker({
      agentId: "agent-1",
      model: "mock",
      provider,
      tools: [listFilesTool],
      workspaceDir,
      messageRepository: {
        append: async () => {},
        listBySession: async () => [],
      } as unknown as IMessageRepository,
      approve: async () => true,
      mind: mindService,
      compute: computeService,
    });
    const events: LLMEvent[] = [];
    const onDone = vi.fn();

    const userMsg: ChatMessage = {
      id: "1",
      role: "user",
      content: [{ type: "text", text: "看下目录" }],
      createdAt: "2024-01-01",
    };
    worker.enqueue({ id: "j1", messages: [userMsg], onEvent: (e) => events.push(e), onDone });

    await vi.waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(onDone).toHaveBeenCalledWith(undefined);

    const toolResult = events.find((e) => e.type === "tool.result") as
      | { output: { success: boolean; output?: { entries: Array<{ name: string; type: string }> }; error?: string } }
      | undefined;
    expect(toolResult).toBeDefined();
    expect(toolResult!.output.success).toBe(true);
    expect(toolResult!.output.output?.entries).toEqual([{ name: "hello.txt", type: "file" }]);
  });
});
