import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { LLMCallRepository } from "../../../src/memory/repositories/llm-call.js";
import type { LLMCallRecord } from "../../../src/memory/repositories/types.js";
import { restoreDataDir } from "../../helpers/env.js";

describe("LLMCallRepository", () => {
  let repo: LLMCallRepository;
  let dataDir: string;
  const originalDataDir = process.env.CLOUDMIND_DATA_DIR;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mc-test-"));
    process.env.CLOUDMIND_DATA_DIR = dataDir;
    repo = new LLMCallRepository("agent-1");
  });

  afterEach(async () => {
    restoreDataDir(originalDataDir);
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const makeRecord = (id: string): LLMCallRecord => ({
    id,
    model: "gpt-4",
    promptTokens: 10,
    completionTokens: 5,
    createdAt: new Date().toISOString(),
  });

  it("appends and lists llm calls", async () => {
    await repo.append(makeRecord("c1"));
    await repo.append(makeRecord("c2"));
    await repo.append(makeRecord("c3"));

    const all = await repo.list();
    expect(all).toHaveLength(3);

    const limited = await repo.list({ limit: 2, offset: 1 });
    expect(limited).toHaveLength(2);
    expect(limited.map((c) => c.id)).toEqual(["c2", "c3"]);
  });
});
