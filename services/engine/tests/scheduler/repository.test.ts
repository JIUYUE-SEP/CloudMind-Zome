import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SchedulerRepository } from "../../src/scheduler/repository.js";
import { DocumentStore } from "../../src/memory/document-store.js";
import { restoreDataDir } from "../helpers/env.js";

describe("SchedulerRepository concurrency", () => {
  let tmpDir: string;
  const originalDataDir = process.env.CLOUDMIND_DATA_DIR;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "scheduler-repo-test-"));
    process.env.CLOUDMIND_DATA_DIR = tmpDir;
  });

  afterEach(async () => {
    restoreDataDir(originalDataDir);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("does not resurrect a task deleted concurrently with an update", async () => {
    const repo = new SchedulerRepository("agent-1");
    const task = await repo.create({
      agentId: "agent-1",
      description: "t",
      prompt: "p",
      cron: "* * * * *",
      enabled: true,
    });

    // 模拟 runTask 持有触发时的旧副本执行 update，与用户 delete 并发。
    // 无论谁先进入队列，任务都必须保持已删除：
    // delete 先 → update 找不到记录抛错且不写入；update 先 → delete 再过滤掉。
    const stale = { ...task, lastRunAt: new Date().toISOString() };
    await Promise.allSettled([repo.update(stale), repo.delete(task.id)]);

    const tasks = await repo.list();
    expect(tasks.find((t) => t.id === task.id)).toBeUndefined();
  });

  it("serializes appends from multiple DocumentStore instances on the same file", async () => {
    const file = path.join(tmpDir, "shared.jsonl");
    const stores = Array.from({ length: 5 }, () => new DocumentStore<{ n: number }>(file));

    await Promise.all(
      stores.flatMap((store, i) =>
        Array.from({ length: 10 }, (_, j) => store.appendLine({ n: i * 10 + j })),
      ),
    );

    const lines = (await fs.readFile(file, "utf-8")).trim().split("\n");
    expect(lines).toHaveLength(50);
    const values = lines.map((l) => (JSON.parse(l) as { n: number }).n).sort((a, b) => a - b);
    expect(values).toEqual(Array.from({ length: 50 }, (_, n) => n));
  });
});
