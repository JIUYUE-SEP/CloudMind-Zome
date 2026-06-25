import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { MessageRepository } from "../../../src/memory/repositories/message.js";
import type { ChatMessageRecord } from "../../../src/memory/repositories/types.js";

describe("MessageRepository", () => {
  let repo: MessageRepository;
  let dataDir: string;
  const originalDataDir = process.env.CLOUDMIND_DATA_DIR;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mc-test-"));
    process.env.CLOUDMIND_DATA_DIR = dataDir;
    repo = new MessageRepository("agent-1");
  });

  afterEach(async () => {
    process.env.CLOUDMIND_DATA_DIR = originalDataDir;
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const makeMessage = (id: string, sessionId: string): ChatMessageRecord => ({
    id,
    sessionId,
    role: "user",
    content: [{ type: "text", text: `msg ${id}` }],
    createdAt: new Date().toISOString(),
  });

  it("appends and lists messages by session", async () => {
    await repo.append(makeMessage("m1", "s1"));
    await repo.append(makeMessage("m2", "s1"));
    await repo.append(makeMessage("m3", "s2"));

    const s1 = await repo.listBySession("s1");
    expect(s1).toHaveLength(2);
    expect(s1.map((m) => m.id)).toEqual(["m1", "m2"]);

    const s2 = await repo.listBySession("s2");
    expect(s2).toHaveLength(1);
  });

  it("paginates with limit and before cursor", async () => {
    for (let i = 0; i < 5; i++) {
      await repo.append(makeMessage(`m${i}`, "s1"));
    }

    const last = await repo.listBySession("s1", { limit: 2 });
    expect(last.map((m) => m.id)).toEqual(["m3", "m4"]);

    const before = await repo.listBySession("s1", { limit: 2, before: "m4" });
    expect(before.map((m) => m.id)).toEqual(["m2", "m3"]);
  });
});
