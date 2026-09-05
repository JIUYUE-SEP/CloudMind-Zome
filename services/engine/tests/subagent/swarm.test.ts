/**
 * SubagentSwarm 集成测试：
 * ② 批量跑通（fake runPuppet 多 item 并行、结果原位聚合）；
 * ⑤ 任务记录 kind=puppet、限流 retry 复用同一 taskId 且 attempts+1（fake timers）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SubagentSwarm } from "../../src/subagent/batch.js";
import { BackgroundManager } from "../../src/subagent/background.js";
import { SubagentTaskRepository } from "../../src/subagent/task-repository.js";
import { restoreDataDir } from "../helpers/env.js";
import type { AgentConfig } from "@cloudmind/shared";

const ownerConfig: AgentConfig = { id: "a1", name: "A1", persona: "", model: "mock", skills: [], tools: [] };

let tmpDir: string;
let originalDataDir: string | undefined;
let repository: SubagentTaskRepository;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "swarm-test-"));
  originalDataDir = process.env.CLOUDMIND_DATA_DIR;
  process.env.CLOUDMIND_DATA_DIR = tmpDir;
  repository = new SubagentTaskRepository(path.join(tmpDir, "subagent-tasks.jsonl"));
});

afterEach(async () => {
  vi.useRealTimers();
  restoreDataDir(originalDataDir);
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

function makeSwarm(
  runPuppet: (owner: string, prompt: string, opts?: { signal?: AbortSignal }) => Promise<string>,
) {
  const background = new BackgroundManager({ runAgent: async () => "" }, repository);
  const swarm = new SubagentSwarm({
    getAgentConfig: async (id) => (id === "a1" ? ownerConfig : undefined),
    runPuppet,
    background,
  });
  return { swarm, background };
}

const items = (texts: string[]) => texts.map((t) => ({ prompt: `处理 ${t}`, item: t }));

describe("② 批量跑通", () => {
  it("多 item 并行执行，结果按下标原位聚合", async () => {
    const { swarm } = makeSwarm(async (_owner, prompt) => `done:${prompt}`);
    const results = await swarm.run("a1", items(["甲", "乙", "丙"]));

    expect(results).toHaveLength(3);
    expect(results.map((r) => r.status)).toEqual(["completed", "completed", "completed"]);
    expect(results.map((r) => r.output)).toEqual(["done:处理 甲", "done:处理 乙", "done:处理 丙"]);
    expect(results.map((r) => r.item)).toEqual(["甲", "乙", "丙"]);
    expect(results.every((r) => typeof r.taskId === "string")).toBe(true);
  });

  it("单个失败不影响其他成员：失败原位落 error", async () => {
    const { swarm } = makeSwarm(async (_owner, prompt) => {
      if (prompt.includes("乙")) throw new Error("puppet boom");
      return `done:${prompt}`;
    });
    const results = await swarm.run("a1", items(["甲", "乙", "丙"]));
    expect(results[0]!.status).toBe("completed");
    expect(results[1]).toMatchObject({ status: "failed" });
    expect(results[1]!.error).toContain("puppet boom");
    expect(results[2]!.status).toBe("completed");
  });

  it("owner 不存在直接抛错，不启动任何傀儡", async () => {
    const { swarm } = makeSwarm(async () => "unreachable");
    await expect(swarm.run("ghost", items(["甲", "乙"]))).rejects.toThrow("Agent ghost not found");
  });
});

describe("⑤ 任务记录与限流续跑", () => {
  it("记录 kind=puppet；429 后 retry 复用同一 taskId、attempts+1、最终 completed", async () => {
    // 真实时钟：runTracked 的落盘是真实 fs I/O，与 fake timers 交织易悬置；
    // 限流退避 3s 真实等待（测试超时放宽到 15s）
    const 甲Attempts: string[] = [];
    // 乙挂起闸门替代固定 200ms 墙钟窗口：甲首次 429 时乙必须仍未完成，
    // 甲才会回队续跑而非末位 failed。以甲首次失败的终态 onUpdate 为放行
    // 信号——该信号之后只剩微任务链上的 requeue 判定，乙的落盘链必在其后，
    // 无墙钟时序依赖
    let release乙!: () => void;
    const 乙Gate = new Promise<string>((resolve) => {
      release乙 = () => resolve("done:处理 乙");
    });
    const { swarm, background } = makeSwarm(async (_owner, prompt) => {
      if (prompt.includes("甲")) {
        甲Attempts.push(prompt);
        if (甲Attempts.length === 1) {
          throw Object.assign(new Error("rate limited"), { status: 429 });
        }
      }
      if (prompt.includes("乙")) {
        return 乙Gate;
      }
      return `done:${prompt}`;
    });
    const off = background.onUpdate((bg) => {
      if (bg.taskDescription.includes("甲") && bg.status === "failed" && bg.notified) {
        off();
        release乙();
      }
    });

    const results = await swarm.run("a1", items(["甲", "乙"]));

    expect(results[0]).toMatchObject({ status: "completed", output: "done:处理 甲" });
    expect(results[1]).toMatchObject({ status: "completed" });
    expect(甲Attempts).toHaveLength(2);

    // 复用同一任务记录：taskId 不变、attempts+1、kind=puppet
    const taskId = results[0]!.taskId!;
    const bg = background.get(taskId);
    expect(bg).toMatchObject({ kind: "puppet", agentId: "a1", attempts: 2, status: "completed" });

    // runTracked 的落盘先于 completion 返回，此时记录已是终态
    const records = await repository.loadAll();
    const record = records.find((r) => r.taskId === taskId)!;
    expect(record).toMatchObject({ kind: "puppet", agentId: "a1", attempts: 2, status: "completed" });
    // 两个 item 恰两条记录（retry 不新建记录）
    expect(records).toHaveLength(2);
  }, 15_000);
});
