/**
 * M23/M24 测试：
 * ① runTracked 硬超时联动 abort 底层 attempt（不再只 reject 空转烧钱）；
 * ② 批量终态聚合：同批任务合并为一条 onBatchTerminal 汇总（含各任务状态摘要），
 *    逐任务 notified 幂等落盘不变；
 * ③ 未接聚合钩子时逐任务回落 onTaskTerminal（语义同单任务路径）；
 * ④ 限流续跑（retryTracked）再终态不重复发汇总；register 单任务路径不变；
 * ⑤ SubagentSwarm 整批集成：一批恰一条汇总通知（batch.ts 接线）；
 * ⑥ 批量通知器：开关关闭不注入、缺省开注入一条汇总。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BackgroundManager, type BackgroundSubagent } from "../../src/subagent/background.js";
import { SubagentTaskRepository } from "../../src/subagent/task-repository.js";
import { SubagentSwarm } from "../../src/subagent/batch.js";
import {
  buildBatchTerminalNoticeText,
  createSubagentBatchTerminalNotifier,
} from "../../src/subagent/notify.js";
import type { SubagentTask } from "../../src/subagent/types.js";
import type { PerceptionInject } from "../../src/plugins/perception/index.js";
import { waitForTerminalTail } from "../helpers/background-tail.js";
import { restoreDataDir } from "../helpers/env.js";
import type { AgentConfig } from "@mindcloud/shared";

const config: AgentConfig = { id: "a2", name: "A2", persona: "", model: "mock", skills: [], tools: [] };
const ownerConfig: AgentConfig = { id: "a1", name: "A1", persona: "", model: "mock", skills: [], tools: [] };

let tmpDir: string;
let originalDataDir: string | undefined;
let repoPath: string;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "subagent-batch-notify-test-"));
  originalDataDir = process.env.CLOUDMIND_DATA_DIR;
  process.env.CLOUDMIND_DATA_DIR = tmpDir;
  repoPath = path.join(tmpDir, "subagent-tasks.jsonl");
});

afterEach(async () => {
  vi.useRealTimers();
  restoreDataDir(originalDataDir);
  await fsp.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function makeTask(id: string): SubagentTask {
  return {
    id,
    parentAgentId: "a1",
    taskDescription: `do ${id}`,
    messages: [],
  };
}

describe("① M23 runTracked 硬超时联动 abort", () => {
  it("超时先 reject（completion 抛超时错）再 abort 底层 attempt（傀儡收到中止）", async () => {
    const repository = new SubagentTaskRepository(repoPath);
    const manager = new BackgroundManager({ runAgent: async () => "" }, repository);
    let aborted = false;
    const handle = manager.startTracked(
      makeTask("t-tracked-timeout"),
      config,
      50,
      "puppet",
      (signal) =>
        new Promise<string>((_, reject) => {
          // 傀儡挂起直到被中止：验证 runTracked 的 signal 真正贯入底层
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("puppet stopped"));
          });
        }),
    );
    await expect(handle.completion).rejects.toThrow(/timeout/);
    expect(aborted).toBe(true);
    await waitForTerminalTail(manager, "t-tracked-timeout");
    expect(manager.get("t-tracked-timeout")).toMatchObject({ status: "failed" });
  });
});

describe("② M24 批量终态聚合", () => {
  it("同批任务终态聚合为一条汇总（含各任务状态摘要），notified 逐任务落盘", async () => {
    const singles: string[] = [];
    const batches: BackgroundSubagent[][] = [];
    const repository = new SubagentTaskRepository(repoPath);
    const manager = new BackgroundManager(
      {
        runAgent: async () => "",
        onTaskTerminal: (bg) => singles.push(bg.taskId),
        onBatchTerminal: (bgs) => batches.push(bgs.map((bg) => ({ ...bg }))),
      },
      repository,
    );
    const batch = { id: "batch-1", total: 2 };
    const h1 = manager.startTracked(makeTask("t-b1"), config, 60_000, "puppet", async () => "out-1", batch);
    const h2 = manager.startTracked(
      makeTask("t-b2"),
      config,
      60_000,
      "puppet",
      async () => {
        throw new Error("boom-2");
      },
      batch,
    );
    // 先挂 rejection handler 再 await h1，避免 h2 的拒绝短暂无 handler
    const h2Expect = expect(h2.completion).rejects.toThrow("boom-2");
    await h1.completion;
    await h2Expect;
    await waitForTerminalTail(manager, "t-b1");
    await waitForTerminalTail(manager, "t-b2");

    // 一条汇总替代两条单任务通知
    expect(singles).toHaveLength(0);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.map((bg) => bg.taskId).sort()).toEqual(["t-b1", "t-b2"]);
    const text = buildBatchTerminalNoticeText(batches[0]!);
    expect(text).toContain("共 2 项");
    expect(text).toContain("1 完成、1 失败");
    expect(text).toContain("out-1");
    expect(text).toContain("boom-2");

    // 逐任务 notified 幂等标记照常落盘
    const records = await repository.loadAll();
    expect(records).toHaveLength(2);
    expect(records.every((r) => r.notified)).toBe(true);
  });

  it("成员先撞 429（failed）再续跑成功：汇总等最终状态，且不重复发", async () => {
    const batches: BackgroundSubagent[][] = [];
    const repository = new SubagentTaskRepository(repoPath);
    const manager = new BackgroundManager(
      {
        runAgent: async () => "",
        onBatchTerminal: (bgs) => batches.push(bgs.map((bg) => ({ ...bg }))),
      },
      repository,
    );
    const batch = { id: "batch-retry", total: 2 };
    // 甲首次 429 式失败（先到终态），乙慢完成；甲随后 retryTracked 续跑成功
    const h1 = manager.startTracked(
      makeTask("t-r1"),
      config,
      60_000,
      "puppet",
      async () => {
        throw Object.assign(new Error("rate limited"), { status: 429 });
      },
      batch,
    );
    let release乙!: () => void;
    const 乙Gate = new Promise<string>((resolve) => {
      release乙 = () => resolve("out-乙");
    });
    const h2 = manager.startTracked(makeTask("t-r2"), config, 60_000, "puppet", () => 乙Gate, batch);

    await expect(h1.completion).rejects.toThrow("rate limited");
    // 甲已 failed（notified），乙未完成 → 汇总未发
    expect(batches).toHaveLength(0);

    // 甲续跑（running）期间乙落地：成员非全终态，汇总仍不发
    const h1b = manager.retryTracked("t-r1", async () => "out-甲-final");
    release乙();
    await h2.completion;
    await h1b.completion;
    await waitForTerminalTail(manager, "t-r1");
    await waitForTerminalTail(manager, "t-r2");

    // 恰一条汇总；甲以最终 completed 入汇总（续跑复用同一记录，成员引用是活对象）
    expect(batches).toHaveLength(1);
    const byId = new Map(batches[0]!.map((bg) => [bg.taskId, bg]));
    expect(byId.get("t-r1")).toMatchObject({ status: "completed", output: "out-甲-final", attempts: 2 });
    expect(byId.get("t-r2")).toMatchObject({ status: "completed" });
  });
});

describe("③ 未接聚合钩子时逐任务回落", () => {
  it("无 onBatchTerminal：批次成员各自走 onTaskTerminal（同单任务语义）", async () => {
    const singles: string[] = [];
    const manager = new BackgroundManager(
      { runAgent: async () => "", onTaskTerminal: (bg) => singles.push(bg.taskId) },
      new SubagentTaskRepository(repoPath),
    );
    const batch = { id: "batch-fallback", total: 2 };
    const h1 = manager.startTracked(makeTask("t-f1"), config, 60_000, "puppet", async () => "o1", batch);
    const h2 = manager.startTracked(makeTask("t-f2"), config, 60_000, "puppet", async () => "o2", batch);
    await Promise.all([h1.completion, h2.completion]);
    await waitForTerminalTail(manager, "t-f1");
    await waitForTerminalTail(manager, "t-f2");
    expect(singles.sort()).toEqual(["t-f1", "t-f2"]);
  });
});

describe("④ 单任务路径不变", () => {
  it("register 单任务仍走 onTaskTerminal（不挂批次不聚合）", async () => {
    const singles: string[] = [];
    const batches: BackgroundSubagent[][] = [];
    const manager = new BackgroundManager(
      {
        runAgent: async () => "single-done",
        onTaskTerminal: (bg) => singles.push(bg.taskId),
        onBatchTerminal: (bgs) => batches.push(bgs),
      },
      new SubagentTaskRepository(repoPath),
    );
    manager.register(makeTask("t-single"), config, 60_000);
    await waitForTerminalTail(manager, "t-single");
    expect(singles).toEqual(["t-single"]);
    expect(batches).toHaveLength(0);
  });
});

describe("⑤ swarm 整批集成（batch.ts 接线）", () => {
  it("一批傀儡终态 → onBatchTerminal 恰好一次（3 项不触发 3 条单通知）", async () => {
    const singles: string[] = [];
    const batches: BackgroundSubagent[][] = [];
    const background = new BackgroundManager(
      {
        runAgent: async () => "",
        onTaskTerminal: (bg) => singles.push(bg.taskId),
        onBatchTerminal: (bgs) => batches.push(bgs.map((bg) => ({ ...bg }))),
      },
      new SubagentTaskRepository(repoPath),
    );
    const swarm = new SubagentSwarm({
      getAgentConfig: async (id) => (id === "a1" ? ownerConfig : undefined),
      runPuppet: async (_owner, prompt) => `done:${prompt}`,
      background,
    });
    const results = await swarm.run("a1", [
      { prompt: "处理 甲", item: "甲" },
      { prompt: "处理 乙", item: "乙" },
      { prompt: "处理 丙", item: "丙" },
    ]);
    expect(results.every((r) => r.status === "completed")).toBe(true);

    await vi.waitFor(() => expect(batches).toHaveLength(1));
    expect(batches[0]).toHaveLength(3);
    expect(singles).toHaveLength(0);
  });
});

describe("⑥ 批量通知器开关与文本", () => {
  const makeBg = (id: string, status: "completed" | "failed"): BackgroundSubagent => ({
    taskId: id,
    parentAgentId: "a1",
    agentId: "a1",
    kind: "puppet",
    taskDescription: `do ${id}`,
    status,
    output: status === "completed" ? `out-${id}` : "",
    outputTruncated: false,
    ...(status === "failed" ? { error: `err-${id}` } : {}),
    startTime: 0,
    timeoutMs: 1,
    attempts: 1,
    notified: true,
  });

  it("缺省开：注入一条汇总（文本含计数与各任务摘要）", async () => {
    // 泛型标注 payload 类型（供下方 mock.calls 取参），实现不声明未用参数
    const injectNotice = vi.fn<(p: PerceptionInject) => Promise<boolean>>(async () => true);
    const notifier = createSubagentBatchTerminalNotifier({
      getAgentConfig: async () => ownerConfig,
      injectNotice,
    });
    notifier([makeBg("t1", "completed"), makeBg("t2", "failed")]);
    // fire-and-forget：宏任务冲刷让注入链落地（无墙钟窗口）
    await new Promise((resolve) => setImmediate(resolve));

    expect(injectNotice).toHaveBeenCalledTimes(1);
    const payload = injectNotice.mock.calls[0]![0];
    expect(payload.targetAgentId).toBe("a1");
    expect(payload.sourceId).toBe("notice_batch_t1");
    expect(payload.text).toContain("共 2 项");
    expect(payload.text).toContain("1 完成、1 失败");
    expect(payload.text).toContain("out-t1");
    expect(payload.text).toContain("err-t2");
  });

  it("subagentNotify=false：不注入（开关语义同单任务）", async () => {
    const injectNotice = vi.fn(async () => true);
    const notifier = createSubagentBatchTerminalNotifier({
      getAgentConfig: async () => ({ ...ownerConfig, subagentNotify: false }),
      injectNotice,
    });
    notifier([makeBg("t1", "completed"), makeBg("t2", "completed")]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(injectNotice).not.toHaveBeenCalled();
  });
});
