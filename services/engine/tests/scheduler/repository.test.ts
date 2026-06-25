import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SchedulerRepository } from "../../src/scheduler/repository.js";

describe("SchedulerRepository", () => {
  let tmpDir: string;
  const originalDataDir = process.env.CLOUDMIND_DATA_DIR;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sched-test-"));
    process.env.CLOUDMIND_DATA_DIR = tmpDir;
  });

  afterEach(async () => {
    process.env.CLOUDMIND_DATA_DIR = originalDataDir;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("creates and lists tasks", async () => {
    const repo = new SchedulerRepository("a1");
    const task = await repo.create({
      agentId: "a1",
      description: "daily",
      prompt: "hi",
      cron: "0 9 * * *",
      enabled: true,
      nextRunAt: "2024-01-01T09:00:00Z",
    });
    const list = await repo.list();
    expect(list).toHaveLength(1);
    expect(list[0].description).toBe("daily");
    expect(list[0].id).toBe(task.id);
  });

  it("updates a task", async () => {
    const repo = new SchedulerRepository("a1");
    const task = await repo.create({
      agentId: "a1",
      description: "daily",
      prompt: "hi",
      cron: "0 9 * * *",
      enabled: true,
    });
    task.description = "weekly";
    await repo.update(task);
    const got = await repo.get(task.id);
    expect(got?.description).toBe("weekly");
  });

  it("deletes a task", async () => {
    const repo = new SchedulerRepository("a1");
    const task = await repo.create({
      agentId: "a1",
      description: "daily",
      prompt: "hi",
      cron: "0 9 * * *",
      enabled: true,
    });
    await repo.delete(task.id);
    const list = await repo.list();
    expect(list).toHaveLength(0);
  });

  it("throws when updating missing task", async () => {
    const repo = new SchedulerRepository("a1");
    await expect(
      repo.update({
        id: "missing",
        agentId: "a1",
        description: "x",
        prompt: "x",
        cron: "0 9 * * *",
        enabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    ).rejects.toThrow("task not found");
  });
});
