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

function recAt(id: string, createdAt: string, sessionId = "s1"): ChatMessageRecord {
  return { ...rec(id, sessionId), createdAt };
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

  it("listBySessionWithArchived：归档 + 热存储合并，按 createdAt 时间序返回完整历史", async () => {
    const repo = new MessageRepository("a1");
    await repo.append(recAt("a1", "2026-08-01T00:00:00.000Z"));
    await repo.append(recAt("a2", "2026-08-02T00:00:00.000Z"));
    await repo.append(recAt("a3", "2026-08-03T00:00:00.000Z"));
    await repo.archiveAndRemove(["a1", "a3"]);
    await repo.append(recAt("h1", "2026-08-04T00:00:00.000Z"));
    await repo.append(recAt("h2", "2026-08-05T00:00:00.000Z"));

    const all = await repo.listBySessionWithArchived("s1");
    expect(all.map((m) => m.id)).toEqual(["a1", "a2", "a3", "h1", "h2"]);

    // 归档消息不再只存在于"她的压缩"里：用户可见完整历史含归档侧
    expect(await repo.listBySession("s1")).toEqual([
      expect.objectContaining({ id: "a2" }),
      expect.objectContaining({ id: "h1" }),
      expect.objectContaining({ id: "h2" }),
    ]);
  });

  it("listBySessionWithArchived：limit 切在归档/热存储边界（跨存储分页）", async () => {
    const repo = new MessageRepository("a1");
    for (let i = 1; i <= 5; i++) {
      await repo.append(recAt(`m${i}`, `2026-08-0${i}T00:00:00.000Z`));
    }
    await repo.archiveAndRemove(["m1", "m2", "m3"]);

    // 最近 3 条：m3 是归档尾、m4/m5 是热存储——窗口恰好跨边界
    expect((await repo.listBySessionWithArchived("s1", { limit: 3 })).map((m) => m.id)).toEqual([
      "m3",
      "m4",
      "m5",
    ]);
    expect((await repo.listBySessionWithArchived("s1", { limit: 4 })).map((m) => m.id)).toEqual([
      "m2",
      "m3",
      "m4",
      "m5",
    ]);
    // 窗口完全落在热存储时也正确（不误读归档尾部）
    expect((await repo.listBySessionWithArchived("s1", { limit: 2 })).map((m) => m.id)).toEqual([
      "m4",
      "m5",
    ]);
  });

  it("listBySessionWithArchived：before 游标跨存储翻页（命中归档继续在归档里翻）", async () => {
    const repo = new MessageRepository("a1");
    for (let i = 1; i <= 5; i++) {
      await repo.append(recAt(`m${i}`, `2026-08-0${i}T00:00:00.000Z`));
    }
    await repo.archiveAndRemove(["m1", "m2", "m3"]);

    // 游标在热存储、窗口伸进归档：m4 之前最近 3 条 = m1/m2/m3
    expect(
      (await repo.listBySessionWithArchived("s1", { limit: 3, before: "m4" })).map((m) => m.id),
    ).toEqual(["m1", "m2", "m3"]);
    // 游标命中归档：继续在归档内部翻页
    expect(
      (await repo.listBySessionWithArchived("s1", { limit: 2, before: "m3" })).map((m) => m.id),
    ).toEqual(["m1", "m2"]);
    // 未知游标：与 listBySession 同语义，回落最近 limit 条
    expect(
      (await repo.listBySessionWithArchived("s1", { limit: 2, before: "ghost" })).map((m) => m.id),
    ).toEqual(["m4", "m5"]);
  });

  it("listBySessionWithArchived：>100MB 归档只取尾部，不触发 readLines 上限（流式分页）", async () => {
    const repo = new MessageRepository("a1");
    await repo.append(recAt("m1", "2026-08-01T00:00:00.000Z"));
    await repo.append(recAt("m2", "2026-08-02T00:00:00.000Z"));
    await repo.archiveAndRemove(["m1", "m2"]);

    // 把归档灌到 100MB 以上（createdAt 介于 m2 与热存储 m3 之间）
    const archivePath = path.join(getAgentDir("a1"), "messages_archived.jsonl");
    const filler = JSON.stringify({
      id: "filler",
      sessionId: "s1",
      role: "user",
      content: [{ type: "text", text: "x".repeat(4096) }],
      createdAt: "2026-08-02T12:00:00.000Z",
    }) + "\n";
    const lineCount = Math.ceil((100 * 1024 * 1024 + Buffer.byteLength(filler)) / Buffer.byteLength(filler));
    await fs.appendFile(archivePath, filler.repeat(lineCount), "utf-8");
    await repo.append(recAt("m3", "2026-08-03T00:00:00.000Z"));

    const tail = await repo.listBySessionWithArchived("s1", { limit: 2 });
    expect(tail.map((m) => m.id)).toEqual(["filler", "m3"]);
  }, 60_000);
});
