import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionRepository } from "../../src/conductor/repository.js";
import { restoreDataDir } from "../helpers/env.js";

describe("SessionRepository", () => {
  let tmpDir: string;
  const originalDataDir = process.env.CLOUDMIND_DATA_DIR;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-test-"));
    process.env.CLOUDMIND_DATA_DIR = tmpDir;
  });

  afterEach(async () => {
    restoreDataDir(originalDataDir);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("creates and lists sessions", async () => {
    const repo = new SessionRepository();
    await repo.create({ name: "Group", agentIds: ["a1", "a2"], type: "group" });
    const list = await repo.list();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("Group");
  });

  it("gets a session by id", async () => {
    const repo = new SessionRepository();
    const created = await repo.create({ name: "Group", agentIds: ["a1"], type: "group" });
    const got = await repo.get(created.id);
    expect(got).toBeDefined();
    expect(got?.name).toBe("Group");
  });

  it("updates a session", async () => {
    const repo = new SessionRepository();
    const created = await repo.create({ name: "Group", agentIds: ["a1"], type: "group" });
    created.name = "Updated";
    await repo.update(created);
    const got = await repo.get(created.id);
    expect(got?.name).toBe("Updated");
  });

  it("deletes a session", async () => {
    const repo = new SessionRepository();
    const created = await repo.create({ name: "Group", agentIds: ["a1"], type: "group" });
    await repo.delete(created.id);
    const list = await repo.list();
    expect(list).toHaveLength(0);
  });

  it("兼容历史 sessions.jsonl：含遗留 mode/projectId 字段的行加载不炸，update 不删旧字段", async () => {
    const repo = new SessionRepository();
    const created = await repo.create({ name: "Old", agentIds: ["a1"], type: "group" });

    // 模拟旧版本写入：直接给落盘行补上 mode/projectId（新代码类型已无该字段）
    const filePath = path.join(tmpDir, "sessions.jsonl");
    const lines = (await fs.readFile(filePath, "utf-8")).trim().split("\n");
    const legacyLines = lines.map((line) => {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (record.id !== created.id) return line;
      return JSON.stringify({ ...record, mode: "code", projectId: "legacy-proj" });
    });
    await fs.writeFile(filePath, legacyLines.join("\n") + "\n", "utf-8");

    // 加载不抛错，字段被忽略但数据仍在
    const loaded = await repo.list();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].name).toBe("Old");

    // update 走 spread 保留未识别字段：旧数据不因新代码写回而被删除
    loaded[0].name = "Updated";
    await repo.update(loaded[0]);
    const raw = await fs.readFile(filePath, "utf-8");
    const saved = JSON.parse(raw.trim().split("\n")[0]) as Record<string, unknown>;
    expect(saved.mode).toBe("code");
    expect(saved.projectId).toBe("legacy-proj");
    expect(saved.name).toBe("Updated");
  });
});
