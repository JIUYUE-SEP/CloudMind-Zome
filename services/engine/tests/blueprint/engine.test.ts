import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeBlueprint } from "../../src/blueprint/engine.js";
import type { Blueprint } from "../../src/blueprint/types.js";
import type { ApiContext } from "../../src/api/context.js";
import { AgentWorker, type Job } from "../../src/core/agent-worker.js";
import { MockLLMProvider } from "../../src/provider/llm.js";
import { MessageRepository } from "../../src/memory/repositories/message.js";
import { getAgentDir } from "../../src/config/paths.js";
import { restoreDataDir } from "../helpers/env.js";

const mockContext = {
  getAgentWorker: async () => undefined,
} as unknown as ApiContext;

async function buildWorkerContext(): Promise<{
  context: ApiContext;
  jobs: Job[];
  provider: MockLLMProvider;
  cleanup: () => Promise<void>;
}> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "blueprint-engine-test-"));
  const originalDataDir = process.env.CLOUDMIND_DATA_DIR;
  process.env.CLOUDMIND_DATA_DIR = tmpDir;

  const jobs: Job[] = [];
  const provider = new MockLLMProvider();
  const worker = new AgentWorker({
    agentId: "a1",
    model: "mock",
    provider,
    tools: [],
    workspaceDir: tmpDir,
    messageRepository: new MessageRepository("a1"),
    approve: () => true,
  });
  const originalEnqueue = worker.enqueue.bind(worker);
  worker.enqueue = (job: Job) => {
    jobs.push(job);
    originalEnqueue(job);
  };

  const context = {
    getAgentWorker: async () => worker,
  } as unknown as ApiContext;

  return {
    context,
    jobs,
    provider,
    cleanup: async () => {
      // 等 worker 收尾（executeBlueprint 在最终 step.end 就 resolve，turn.end
      // 与队列收尾仍在飞）再删临时目录，避免 rm 与异步写撞车
      const deadline = Date.now() + 5000;
      while (worker.status !== "idle" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      restoreDataDir(originalDataDir);
    },
  };
}

function llmBlueprint(): Blueprint {
  return {
    id: "b-llm",
    name: "LLM Flow",
    nodes: [
      { id: "start", type: "start", x: 0, y: 0 },
      {
        id: "llm",
        type: "llm",
        x: 200,
        y: 0,
        config: { agentId: "a1", prompt: "research then answer" },
      },
      { id: "end", type: "end", x: 400, y: 0 },
    ],
    edges: [
      { source: "start", target: "llm" },
      { source: "llm", target: "end" },
    ],
    createdAt: "2024-01-01",
    updatedAt: "2024-01-01",
  };
}

describe("executeBlueprint", () => {
  it("executes start -> end blueprint", async () => {
    const blueprint: Blueprint = {
      id: "b1",
      name: "Test",
      nodes: [
        { id: "start", type: "start", x: 0, y: 0 },
        { id: "end", type: "end", x: 200, y: 0 },
      ],
      edges: [{ source: "start", target: "end" }],
      createdAt: "2024-01-01",
      updatedAt: "2024-01-01",
    };
    const result = await executeBlueprint(blueprint, mockContext, { initialInput: "hello" });
    expect(result.status).toBe("completed");
    expect(result.outputs["end"]).toBe("hello");
  });

  it("fails when start node is missing", async () => {
    const blueprint: Blueprint = {
      id: "b1",
      name: "Test",
      nodes: [{ id: "end", type: "end", x: 0, y: 0 }],
      edges: [],
      createdAt: "2024-01-01",
      updatedAt: "2024-01-01",
    };
    const result = await executeBlueprint(blueprint, mockContext);
    expect(result.status).toBe("failed");
  });

  it("reports tool not found for unknown tool", async () => {
    const blueprint: Blueprint = {
      id: "b1",
      name: "Test",
      nodes: [
        { id: "start", type: "start", x: 0, y: 0 },
        { id: "tool", type: "tool", x: 200, y: 0, config: { toolName: "unknown", arguments: {} } },
        { id: "end", type: "end", x: 400, y: 0 },
      ],
      edges: [
        { source: "start", target: "tool" },
        { source: "tool", target: "end" },
      ],
      createdAt: "2024-01-01",
      updatedAt: "2024-01-01",
    };
    const result = await executeBlueprint(blueprint, mockContext);
    expect(result.status).toBe("completed");
    expect(result.outputs["tool"]).toContain("tool not found");
  });

  it.each(["run_command", "write_file", "bash"])(
    "refuses requiresApproval tool in blueprints: %s",
    async (toolName) => {
      const blueprint: Blueprint = {
        id: "b1",
        name: "Test",
        nodes: [
          { id: "start", type: "start", x: 0, y: 0 },
          { id: "tool", type: "tool", x: 200, y: 0, config: { toolName, arguments: {} } },
          { id: "end", type: "end", x: 400, y: 0 },
        ],
        edges: [
          { source: "start", target: "tool" },
          { source: "tool", target: "end" },
        ],
        createdAt: "2024-01-01",
        updatedAt: "2024-01-01",
      };
      // blueprint 无人工审批通道，危险工具必须被拒绝而不是 executeTool 直跑
      const result = await executeBlueprint(blueprint, mockContext);
      expect(result.status).toBe("completed");
      expect(result.outputs["tool"]).toContain("requires approval");
    },
  );

  it("refuses send_private_message in blueprints（蓝图不是人形，无社交权）", async () => {
    const blueprint: Blueprint = {
      id: "b1",
      name: "Test",
      nodes: [
        { id: "start", type: "start", x: 0, y: 0 },
        {
          id: "tool",
          type: "tool",
          x: 200,
          y: 0,
          config: { toolName: "send_private_message", arguments: { to: "a2", content: "hi" } },
        },
        { id: "end", type: "end", x: 400, y: 0 },
      ],
      edges: [
        { source: "start", target: "tool" },
        { source: "tool", target: "end" },
      ],
      createdAt: "2024-01-01",
      updatedAt: "2024-01-01",
    };
    const result = await executeBlueprint(blueprint, mockContext);
    expect(result.status).toBe("completed");
    expect(result.outputs["tool"]).toContain("无社交权");
  });

  it("P1-6：工具调用型 LLM 节点只在收尾步 resolve，返回最终文本而非首步空文本", async () => {
    const { context, jobs, provider, cleanup } = await buildWorkerContext();
    try {
      // 首步发起工具调用（ReAct 中间步），第二步才产出最终文本
      provider.setNextToolCalls([
        { toolCallId: "tc-1", name: "web_search", arguments: { query: "x" } },
      ]);
      const result = await executeBlueprint(llmBlueprint(), context, { initialInput: "hello" });
      expect(result.status).toBe("completed");
      expect(result.outputs["end"]).toBe("Hello from mock");
      expect(result.outputs["end"]).not.toBe("(empty)");
      expect(jobs).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  it("P1-6：蓝图流量独立命名空间 + 瞬态回合，不进 agent 主会话热存储/话题 tracker", async () => {
    const { context, jobs, provider, cleanup } = await buildWorkerContext();
    try {
      provider.setNextToolCalls([
        { toolCallId: "tc-1", name: "web_search", arguments: { query: "x" } },
      ]);
      const result = await executeBlueprint(llmBlueprint(), context, { initialInput: "hello" });
      expect(result.status).toBe("completed");

      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.sessionId).toMatch(/^blueprint:/);
      expect(jobs[0]!.ephemeral).toBe(true);

      // 主会话热存储：messages.jsonl 完全没有蓝图流量（瞬态回合不落盘）
      const agentDir = getAgentDir("a1");
      await expect(fs.readFile(path.join(agentDir, "messages.jsonl"), "utf-8")).rejects.toThrow();
      expect(await new MessageRepository("a1").listBySession("a1")).toEqual([]);
      expect(await new MessageRepository("a1").listBySessionPrefix("blueprint:")).toEqual([]);
      // 话题 tracker：无开放话题落盘（topic-state.json 不产生）
      await expect(fs.readFile(path.join(agentDir, "topic-state.json"), "utf-8")).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });
});
