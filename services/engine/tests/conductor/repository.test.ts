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
});
