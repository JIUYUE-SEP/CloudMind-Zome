import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MessageRepository } from "../../src/memory/repositories/message.js";
import type { ChatMessageRecord } from "../../src/memory/repositories/types.js";
import { restoreDataDir } from "../helpers/env.js";

function rec(id: string, sessionId = "s1"): ChatMessageRecord {
  return {
    id,
    sessionId,
    role: "user",
    content: [{ type: "text", text: `消息 ${id}` }],
    createdAt: new Date().toISOString(),
  };
}

describe("MessageRepository 归档", () => {
  let tmpDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "msg-archive-test-"));
    originalDataDir = process.env.CLOUDMIND_DATA_DIR;
    process.env.CLOUDMIND_DATA_DIR = tmpDir;
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    restoreDataDir(originalDataDir);
  });

  it("archiveAndRemove：热存储移除，归档可恢复", async () => {
    const repo = new MessageRepository("a1");
    await repo.append(rec("m1"));
    await repo.append(rec("m2"));
    await repo.append(rec("m3"));

    await repo.archiveAndRemove(["m1", "m3"]);

    // 热存储只剩 m2
    const hot = await repo.listBySession("s1");
    expect(hot.map((m) => m.id)).toEqual(["m2"]);

    // 归档完整可恢复
    const archived = await repo.getArchivedByIds(["m1", "m3"]);
    expect(archived.map((m) => m.id).sort()).toEqual(["m1", "m3"]);
    expect(archived.find((m) => m.id === "m1")?.content[0]).toEqual({ type: "text", text: "消息 m1" });
  });

  it("归档是追加式：多次归档累积", async () => {
    const repo = new MessageRepository("a1");
    await repo.append(rec("m1"));
    await repo.archiveAndRemove(["m1"]);
    await repo.append(rec("m2"));
    await repo.archiveAndRemove(["m2"]);

    const archived = await repo.getArchivedByIds(["m1", "m2"]);
    expect(archived).toHaveLength(2);
  });

  it("不存在的 id：热存储与归档均不变", async () => {
    const repo = new MessageRepository("a1");
    await repo.append(rec("m1"));
    await repo.archiveAndRemove(["ghost"]);

    expect(await repo.listBySession("s1")).toHaveLength(1);
    expect(await repo.getArchivedByIds(["ghost"])).toEqual([]);
  });

  it("空 ids 列表是 no-op", async () => {
    const repo = new MessageRepository("a1");
    await repo.append(rec("m1"));
    await repo.archiveAndRemove([]);
    expect(await repo.listBySession("s1")).toHaveLength(1);
  });
});
