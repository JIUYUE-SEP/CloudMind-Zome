import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SubagentDispatcher } from "../../src/subagent/dispatcher.js";
import { BackgroundManager } from "../../src/subagent/background.js";
import { SubagentTaskRepository } from "../../src/subagent/task-repository.js";
import { waitForTerminalTail } from "../helpers/background-tail.js";
import { restoreDataDir } from "../helpers/env.js";
import type { ChatMessage } from "@mindcloud/shared";
import type { AgentConfig } from "@mindcloud/shared";

const config: AgentConfig = { id: "a2", name: "A2", persona: "", model: "mock", skills: [], tools: [] };

// 共享临时目录：BackgroundManager 的状态变更落盘指向这里，不污染真实 DATA_DIR
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-dispatcher-test-"));
let repoSeq = 0;
let originalDataDir: string | undefined;

beforeEach(() => {
  // 输出全量日志（writeTaskOutput 走 getAgentDir）也指向临时目录，
  // 否则会落到真实 ~/.cloudmind-zome/agents/...（共享 fixture 未隔离）；
  // 与兄弟文件同款 beforeEach/afterEach 隔离，免疫测试池配置漂移
  originalDataDir = process.env.CLOUDMIND_DATA_DIR;
  process.env.CLOUDMIND_DATA_DIR = tmpDir;
});

afterEach(() => {
  restoreDataDir(originalDataDir);
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

type RunAgent = (agentId: string, messages: ChatMessage[], opts?: { signal?: AbortSignal }) => Promise<string>;

function makeBackground(runAgent: RunAgent): BackgroundManager {
  return new BackgroundManager(
    { runAgent },
    new SubagentTaskRepository(path.join(tmpDir, `tasks-${repoSeq++}.jsonl`)),
  );
}

describe("SubagentDispatcher", () => {
  it("borrows agent config and runs foreground", async () => {
    const dispatcher = new SubagentDispatcher({
      getAgentConfig: async () => config,
      runAgent: async () => "ok",
    });
    const result = await dispatcher.dispatch("a1", "a2", "do work", { mode: "foreground" });
    expect(result).toMatchObject({ output: "ok" });
    expect((result as { error?: string }).error).toBeUndefined();
  });

  it("rejects dispatching to itself", async () => {
    const dispatcher = new SubagentDispatcher({
      getAgentConfig: async () => config,
      runAgent: async () => "ok",
    });
    await expect(dispatcher.dispatch("a2", "a2", "do work", { mode: "foreground" })).rejects.toThrow(
      "cannot dispatch to itself"
    );
  });

  it("rejects unknown agent", async () => {
    const dispatcher = new SubagentDispatcher({
      getAgentConfig: async () => undefined,
      runAgent: async () => "ok",
    });
    await expect(dispatcher.dispatch("a1", "ghost", "do work", { mode: "foreground" })).rejects.toThrow(
      "Agent ghost not found"
    );
  });

  it("returns timeout error when foreground run exceeds timeout", async () => {
    // 受控 gate 代替 `new Promise(() => {})`：断言超时语义后放行，
    // 不留永挂 promise 给进程/后续用例
    let releaseRun!: () => void;
    const gate = new Promise<string>((resolve) => {
      releaseRun = () => resolve("late result");
    });
    const dispatcher = new SubagentDispatcher({
      getAgentConfig: async () => config,
      runAgent: () => gate,
    });
    const result = await dispatcher.dispatch("a1", "a2", "do work", { mode: "foreground", timeoutMs: 20 });
    expect(result).toMatchObject({ output: "", error: "timeout" });
    releaseRun();
    await gate;
  });

  it("aborts the underlying run when foreground run times out", async () => {
    let receivedSignal: AbortSignal | undefined;
    let releaseRun!: () => void;
    const gate = new Promise<string>((resolve) => {
      releaseRun = () => resolve("late result");
    });
    const dispatcher = new SubagentDispatcher({
      getAgentConfig: async () => config,
      runAgent: (_id, _messages, opts) => {
        receivedSignal = opts?.signal;
        return gate;
      },
    });
    const result = await dispatcher.dispatch("a1", "a2", "do work", { mode: "foreground", timeoutMs: 20 });
    expect(result).toMatchObject({ output: "", error: "timeout" });
    // 超时后必须真正中止 worker 里仍在跑的任务，而不是只放弃等待
    expect(receivedSignal?.aborted).toBe(true);
    releaseRun();
    await gate;
  });

  it("aborts the underlying run when background task times out", async () => {
    let receivedSignal: AbortSignal | undefined;
    let releaseRun!: () => void;
    const gate = new Promise<string>((resolve) => {
      releaseRun = () => resolve("late result");
    });
    const background = makeBackground((_id, _messages, opts) => {
      receivedSignal = opts?.signal;
      return gate;
    });
    const dispatcher = new SubagentDispatcher({
      getAgentConfig: async () => config,
      runAgent: async () => "ok",
      background,
    });
    const taskId = (await dispatcher.dispatch("a1", "a2", "do work", {
      mode: "background",
      timeoutMs: 20,
    })) as string;
    // 尾巴信号在 20ms 超时触发前挂上，保证能等到 run() 的收尾 notify
    const tail = waitForTerminalTail(background, taskId);
    await vi.waitFor(() => expect(background.get(taskId)?.status).toBe("failed"));
    expect(background.get(taskId)?.error).toContain("timeout");
    expect(receivedSignal?.aborted).toBe(true);
    releaseRun();
    // 后台 run() 的收尾尾巴（failed/notified 落盘）排空后再结束用例
    await tail;
  });

  it("registers background task and returns task id", async () => {
    const background = makeBackground(async () => "ok");
    const dispatcher = new SubagentDispatcher({
      getAgentConfig: async () => config,
      runAgent: async () => "ok",
      background,
    });
    const result = await dispatcher.dispatch("a1", "a2", "do work", { mode: "background" });
    expect(typeof result).toBe("string");
    const bg = background.get(result as string);
    expect(bg).toBeDefined();
    expect(bg?.taskDescription).toBe("do work");
  });

  it("marks background task completed with final output", async () => {
    const background = makeBackground(async () => "final text");
    const dispatcher = new SubagentDispatcher({
      getAgentConfig: async () => config,
      runAgent: async () => "final text",
      background,
    });
    const taskId = (await dispatcher.dispatch("a1", "a2", "do work", { mode: "background" })) as string;
    // 注册后立即挂尾巴信号，终态收尾后直接断言（与同文件 timeout 用例同范式）
    const tail = waitForTerminalTail(background, taskId);
    await tail;
    expect(background.get(taskId)).toMatchObject({ status: "completed", output: "final text" });
  });

  it("marks background task failed when runAgent rejects", async () => {
    const background = makeBackground(async () => {
      throw new Error("boom");
    });
    const dispatcher = new SubagentDispatcher({
      getAgentConfig: async () => config,
      runAgent: async () => "ok",
      background,
    });
    const taskId = (await dispatcher.dispatch("a1", "a2", "do work", { mode: "background" })) as string;
    const tail = waitForTerminalTail(background, taskId);
    await tail;
    expect(background.get(taskId)?.status).toBe("failed");
    expect(background.get(taskId)?.error).toContain("boom");
  });
});
