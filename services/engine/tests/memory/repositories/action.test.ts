import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ActionRepository } from "../../../src/memory/repositories/action.js";
import type { ActionRecord } from "../../../src/memory/repositories/types.js";
import { restoreDataDir } from "../../helpers/env.js";

describe("ActionRepository", () => {
  let repo: ActionRepository;
  let dataDir: string;
  const originalDataDir = process.env.CLOUDMIND_DATA_DIR;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mc-test-"));
    process.env.CLOUDMIND_DATA_DIR = dataDir;
    repo = new ActionRepository("agent-1");
  });

  afterEach(async () => {
    restoreDataDir(originalDataDir);
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const makeRecord = (id: string, status: ActionRecord["status"]): ActionRecord => ({
    id,
    status,
    description: `action ${id}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  it("appends and lists actions", async () => {
    await repo.append(makeRecord("a1", "pending"));
    await repo.append(makeRecord("a2", "running"));

    const all = await repo.list();
    expect(all).toHaveLength(2);
  });

  it("gets an action by id", async () => {
    await repo.append(makeRecord("a1", "pending"));
    const got = await repo.get("a1");
    expect(got?.status).toBe("pending");
  });

  it("updates an action", async () => {
    await repo.append(makeRecord("a1", "pending"));
    const updated = { ...(await repo.get("a1"))!, status: "completed" as const, updatedAt: new Date().toISOString() };
    await repo.update(updated);
    const got = await repo.get("a1");
    expect(got?.status).toBe("completed");
  });

  it("throws when updating missing action", async () => {
    const record = makeRecord("missing", "pending");
    await expect(repo.update(record)).rejects.toThrow("action not found");
  });
});
