import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { MessageRepository } from "../../../src/memory/repositories/message.js";
import type { ChatMessageRecord } from "../../../src/memory/repositories/types.js";
import { restoreDataDir } from "../../helpers/env.js";

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
    restoreDataDir(originalDataDir);
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

  it("before 游标指向首条消息时返回空页（M37 边界）", async () => {
    for (let i = 0; i < 5; i++) {
      await repo.append(makeMessage(`m${i}`, "s1"));
    }
    // 首条之前没有任何消息：应为空页，而不是落回全量窗口
    expect(await repo.listBySession("s1", { limit: 2, before: "m0" })).toEqual([]);
  });

  it("before 游标不存在时按无游标处理（既有口径不变）", async () => {
    for (let i = 0; i < 5; i++) {
      await repo.append(makeMessage(`m${i}`, "s1"));
    }
    const page = await repo.listBySession("s1", { limit: 2, before: "ghost" });
    expect(page.map((m) => m.id)).toEqual(["m3", "m4"]);
  });

  it("getByIds：按文件序返回、缺失 id 跳过、空入参短路", async () => {
    await repo.append(makeMessage("m1", "s1"));
    await repo.append(makeMessage("m2", "s1"));
    await repo.append(makeMessage("m3", "s1"));

    // 传入顺序不影响返回顺序（保持文件序），不存在的 id 静默跳过
    const found = await repo.getByIds(["m3", "ghost", "m1"]);
    expect(found.map((m) => m.id)).toEqual(["m1", "m3"]);
    expect(await repo.getByIds([])).toEqual([]);
  });

  it("getByIds：读缓存命中时不再全量解析（M9 性能语义）", async () => {
    await repo.append(makeMessage("m1", "s1"));
    await repo.append(makeMessage("m2", "s1"));

    await repo.getByIds(["m1"]); // 首次未命中：全量解析并回填读缓存
    const parseSpy = vi.spyOn(JSON, "parse");
    try {
      const found = await repo.getByIds(["m2"]);
      expect(found.map((m) => m.id)).toEqual(["m2"]);
      // 命中读缓存：整表零 JSON.parse，只深拷贝命中项
      expect(parseSpy).not.toHaveBeenCalled();
    } finally {
      parseSpy.mockRestore();
    }
  });

  it("getByIds：新追加后读到新数据（进程内写主动失效缓存）", async () => {
    await repo.append(makeMessage("m1", "s1"));
    await repo.getByIds(["m1"]); // 回填缓存

    await repo.append(makeMessage("m2", "s1"));
    const found = await repo.getByIds(["m1", "m2"]);
    expect(found.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("getByIds：缓存命中的返回值是独立副本，调用方改动不污染后续读取", async () => {
    await repo.append(makeMessage("m1", "s1"));
    await repo.getByIds(["m1"]); // 回填缓存

    const hit = await repo.getByIds(["m1"]); // 命中路径：深拷贝自缓存
    hit[0]!.content = [{ type: "text", text: "已篡改" }];

    const reread = await repo.getByIds(["m1"]);
    expect(reread[0]!.content[0]).toEqual({ type: "text", text: "msg m1" });
  });
});
