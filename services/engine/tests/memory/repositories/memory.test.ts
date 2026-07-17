import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { MemoryRepository } from "../../../src/memory/repositories/memory.js";
import type { MemoryRecord } from "../../../src/memory/repositories/types.js";
import { restoreDataDir } from "../../helpers/env.js";

describe("MemoryRepository", () => {
  let repo: MemoryRepository;
  let dataDir: string;
  const originalDataDir = process.env.CLOUDMIND_DATA_DIR;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mc-test-"));
    process.env.CLOUDMIND_DATA_DIR = dataDir;
    repo = new MemoryRepository("agent-1");
  });

  afterEach(async () => {
    restoreDataDir(originalDataDir);
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const makeRecord = (id: string): MemoryRecord => ({
    id,
    content: `memory ${id}`,
    embeddingId: `emb-${id}`,
    createdAt: new Date().toISOString(),
  });

  it("appends and lists memories", async () => {
    await repo.append(makeRecord("r1"));
    await repo.append(makeRecord("r2"));

    const all = await repo.list();
    expect(all).toHaveLength(2);

    const limited = await repo.list({ limit: 1, offset: 1 });
    expect(limited).toHaveLength(1);
    expect(limited[0].id).toBe("r2");
  });

  it("retrieves a memory by id", async () => {
    await repo.append(makeRecord("r1"));
    const got = await repo.get("r1");
    expect(got?.content).toBe("memory r1");
    const missing = await repo.get("missing");
    expect(missing).toBeUndefined();
  });
});
