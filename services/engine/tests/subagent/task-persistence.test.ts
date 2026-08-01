/**
 * subagent 后台任务持久化测试：
 * ① 持久化往返（注册→流转→重读一致）；② 模拟重启 running 标 lost 且可查询；
 * ③ kind 落盘与暴露（默认 delegate）；④ 输出双轨（超 4KB 截尾 preview + 全量 log 可读）。
 * CLOUDMIND_DATA_DIR 指向临时目录（输出 log 落在 parent agent 目录下），不污染真实数据目录。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { BackgroundManager } from "../../src/subagent/background.js";
import {
  OUTPUT_PREVIEW_MAX_CHARS,
  SubagentTaskRepository,
} from "../../src/subagent/task-repository.js";
import type { SubagentTask } from "../../src/subagent/types.js";
import { waitForTerminalTail } from "../helpers/background-tail.js";
import { restoreDataDir } from "../helpers/env.js";
import type { AgentConfig } from "@mindcloud/shared";

const config: AgentConfig = { id: "a2", name: "A2", persona: "", model: "mock", skills: [], tools: [] };

let tmpDir: string;
let originalDataDir: string | undefined;
let repoPath: string;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "subagent-persist-test-"));
  originalDataDir = process.env.CLOUDMIND_DATA_DIR;
  process.env.CLOUDMIND_DATA_DIR = tmpDir;
  repoPath = path.join(tmpDir, "subagent-tasks.jsonl");
});

afterEach(async () => {
  vi.useRealTimers();
  restoreDataDir(originalDataDir);
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

function makeTask(id: string): SubagentTask {
  return {
    id,
    parentAgentId: "a1",
    taskDescription: "do work",
    messages: [
      {
        id: randomUUID(),
        role: "user",
        content: [{ type: "text", text: "do work" }],
        createdAt: new Date().toISOString(),
      },
    ],
  };
}

describe("① 持久化往返", () => {
  it("注册→完成→repository 重读一致（含 preview 与状态流转）", async () => {
    const repository = new SubagentTaskRepository(repoPath);
    const manager = new BackgroundManager({ runAgent: async () => "done text" }, repository);

    manager.register(makeTask(randomUUID()), config, 60_000);
    const taskId = manager.list()[0]!.taskId;
    // 终态尾巴（output.log/终态落盘/notified 落盘）收完再断言，
    // 不依赖 1s 轮询预算与内存状态先于落盘翻转的时序
    await waitForTerminalTail(manager, taskId);

    const records = await repository.loadAll();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      taskId,
      parentAgentId: "a1",
      agentId: "a2",
      kind: "delegate",
      status: "completed",
      outputPreview: "done text",
      outputTruncated: false,
    });
    expect(records[0]!.startTime).toBeGreaterThan(0);
    expect(records[0]!.endTime).toBeGreaterThan(0);
  });

  it("失败任务同样落盘（status failed + error）", async () => {
    const repository = new SubagentTaskRepository(repoPath);
    const manager = new BackgroundManager(
      {
        runAgent: async () => {
          throw new Error("bg boom");
        },
      },
      repository,
    );

    manager.register(makeTask(randomUUID()), config, 60_000);
    const taskId = manager.list()[0]!.taskId;
    await waitForTerminalTail(manager, taskId);

    const record = (await repository.loadAll())[0]!;
    expect(record.error).toContain("bg boom");
  });
});

describe("② 重启 lost 语义", () => {
  it("新 repository/manager 实例 load()：running 标 lost 且可查询", async () => {
    // fake timers：模拟崩溃的"永不返回"任务不再挂真实 60s 超时定时器
    // （真实定时器会让本文件 fork 多活 60s）；vi.waitFor 在 fake timers
    // 下自动推进，落盘轮询不受影响
    vi.useFakeTimers();
    // 上一世：任务一直处于 running（runAgent 永不返回），模拟 engine 崩溃/重启
    const repository = new SubagentTaskRepository(repoPath);
    const manager = new BackgroundManager({ runAgent: () => new Promise(() => {}) }, repository);
    manager.register(makeTask(randomUUID()), config, 60_000);
    const taskId = manager.list()[0]!.taskId;
    await vi.waitFor(async () => {
      const records = await repository.loadAll();
      expect(records.find((r) => r.taskId === taskId)?.status).toBe("running");
    });

    // 重启：新实例从同一文件加载
    const repository2 = new SubagentTaskRepository(repoPath);
    const manager2 = new BackgroundManager({ runAgent: async () => "" }, repository2);
    await manager2.load();

    const restored = manager2.get(taskId);
    expect(restored?.status).toBe("lost");
    expect(restored?.endTime).toBeGreaterThan(0);
    expect(manager2.list()).toHaveLength(1);
    // 落盘也已标 lost（不知死活≠已知失败）
    const records = await repository2.loadAll();
    expect(records.find((r) => r.taskId === taskId)?.status).toBe("lost");
  });

  it("已完结任务不受 lost 对账影响", async () => {
    const repository = new SubagentTaskRepository(repoPath);
    const manager = new BackgroundManager({ runAgent: async () => "ok" }, repository);
    manager.register(makeTask(randomUUID()), config, 60_000);
    const taskId = manager.list()[0]!.taskId;
    await waitForTerminalTail(manager, taskId);

    const manager2 = new BackgroundManager(
      { runAgent: async () => "" },
      new SubagentTaskRepository(repoPath),
    );
    await manager2.load();
    expect(manager2.get(taskId)?.status).toBe("completed");
    expect(manager2.get(taskId)?.output).toBe("ok");
  });
});

describe("③ kind 分型埋入", () => {
  it("register 默认 delegate；显式 puppet 落盘与暴露正确", async () => {
    const repository = new SubagentTaskRepository(repoPath);
    const manager = new BackgroundManager({ runAgent: async () => "ok" }, repository);

    manager.register(makeTask(randomUUID()), config, 60_000);
    manager.register(makeTask(randomUUID()), config, 60_000, "puppet");
    const [delegateTask, puppetTask] = manager.list();
    // 两个任务的异步尾巴都收完再断言（确定性信号，无 1s 轮询预算）
    await Promise.all([
      waitForTerminalTail(manager, delegateTask!.taskId),
      waitForTerminalTail(manager, puppetTask!.taskId),
    ]);

    expect(manager.get(delegateTask!.taskId)?.kind).toBe("delegate");
    expect(manager.get(puppetTask!.taskId)?.kind).toBe("puppet");
    const records = await repository.loadAll();
    expect(records.find((r) => r.taskId === delegateTask!.taskId)?.kind).toBe("delegate");
    expect(records.find((r) => r.taskId === puppetTask!.taskId)?.kind).toBe("puppet");
  });
});

describe("④ 输出双轨", () => {
  it("超 4KB：preview 截尾标记 + 全量 output.log 可读；未超不截断", async () => {
    const big = "x".repeat(OUTPUT_PREVIEW_MAX_CHARS * 2) + "TAIL";
    const repository = new SubagentTaskRepository(repoPath);
    const manager = new BackgroundManager(
      { runAgent: async () => big },
      repository,
    );
    manager.register(makeTask(randomUUID()), config, 60_000);
    const taskId = manager.list()[0]!.taskId;
    // 等尾巴收完再断言：内存状态翻转先于 output.log 落盘，
    // 直接断言会撞上日志尚未写入的窗口
    await waitForTerminalTail(manager, taskId);

    // 内存/任务表只存截尾 preview（末尾 4096 字符，结尾通常是结论）
    const bg = manager.get(taskId)!;
    expect(bg.outputTruncated).toBe(true);
    expect(bg.output.length).toBe(OUTPUT_PREVIEW_MAX_CHARS);
    expect(bg.output.endsWith("TAIL")).toBe(true);

    // 全量日志落 parent agent 目录且可读
    const logPath = path.join(tmpDir, "agents", "a1", "subagent-tasks", `${taskId}.output.log`);
    expect(fs.existsSync(logPath)).toBe(true);
    expect(await manager.readFullOutput(taskId)).toBe(big);

    // 任务表 JSONL 里同样只有 preview
    const record = (await repository.loadAll())[0]!;
    expect(record.outputTruncated).toBe(true);
    expect(record.outputPreview.length).toBe(OUTPUT_PREVIEW_MAX_CHARS);
  });

  it("小输出不写截断标记，全量与 preview 一致", async () => {
    const repository = new SubagentTaskRepository(repoPath);
    const manager = new BackgroundManager({ runAgent: async () => "small" }, repository);
    manager.register(makeTask(randomUUID()), config, 60_000);
    const taskId = manager.list()[0]!.taskId;
    await waitForTerminalTail(manager, taskId);

    expect(manager.get(taskId)?.outputTruncated).toBe(false);
    expect(await manager.readFullOutput(taskId)).toBe("small");
  });
});
