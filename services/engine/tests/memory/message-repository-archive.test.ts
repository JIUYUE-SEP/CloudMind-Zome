import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MessageRepository } from "../../src/memory/repositories/message.js";
import type { ChatMessageRecord } from "../../src/memory/repositories/types.js";
import { getAgentDir } from "../../src/config/paths.js";
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

  it("恢复路径不受归档文件大小影响：>100MB 归档仍可 getArchivedByIds", async () => {
    // 回归背景（review M10）：messages_archived.jsonl 只增不减，撞 readLines
    // 100MB 硬上限后旧实现永远抛错——最需要恢复的场景恰好排在引爆点之后。
    const repo = new MessageRepository("a1");
    await repo.append(rec("m1"));
    await repo.append(rec("m2"));
    await repo.archiveAndRemove(["m1", "m2"]);

    // 直接把归档灌到 100MB 以上（大行压低行数，控制测试时长）
    const archivePath = path.join(getAgentDir("a1"), "messages_archived.jsonl");
    const filler = JSON.stringify({
      id: "filler",
      sessionId: "s1",
      role: "user",
      content: [{ type: "text", text: "x".repeat(4096) }],
      createdAt: new Date().toISOString(),
    }) + "\n";
    const lineCount = Math.ceil((100 * 1024 * 1024 + Buffer.byteLength(filler)) / Buffer.byteLength(filler));
    await fs.appendFile(archivePath, filler.repeat(lineCount), "utf-8");

    const archived = await repo.getArchivedByIds(["m1", "m2"]);
    expect(archived.map((m) => m.id).sort()).toEqual(["m1", "m2"]);
    expect(await repo.getArchivedByIds(["ghost"])).toEqual([]);
  }, 60_000);
});
