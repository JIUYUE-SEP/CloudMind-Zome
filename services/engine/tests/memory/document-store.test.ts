import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DocumentStore } from "../../src/memory/document-store.js";

describe("DocumentStore", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "doc-store-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("writeLines 在目标文件被并发读句柄短暂占用时重试 rename 并最终成功", async () => {
    // 回归背景：Windows 上 rename 覆盖被读句柄占用的文件会 EPERM
    // （scheduler 写回 scheduler.jsonl 时轮询正在 readLines 的真实缺陷）
    const store = new DocumentStore<{ v: number }>(path.join(tmpDir, "data.jsonl"));
    await store.appendLine({ v: 1 });

    // 模拟并发读：持有读句柄 200ms，覆盖 rename 的前几次重试
    const handle = await fs.open(store.filePath, "r");
    const writePromise = store.writeLines([{ v: 1 }, { v: 2 }]);
    await new Promise((r) => setTimeout(r, 200));
    await handle.close();

    await writePromise; // 未修复时这里会抛 EPERM
    await expect(store.readLines()).resolves.toEqual([{ v: 1 }, { v: 2 }]);
  });

  it("mutateLines 读-改-写保持原子性（并发更新不丢）", async () => {
    const store = new DocumentStore<{ v: number }>(path.join(tmpDir, "data.jsonl"));
    await store.appendLine({ v: 0 });
    await Promise.all([
      store.mutateLines((rs) => rs.map((r) => ({ v: r.v + 1 }))),
      store.mutateLines((rs) => rs.map((r) => ({ v: r.v + 1 }))),
    ]);
    const lines = await store.readLines();
    expect(lines).toEqual([{ v: 2 }]);
  });

  it("读缓存：重复读结果一致，append 后缓存失效读到新数据", async () => {
    const store = new DocumentStore<{ v: number }>(path.join(tmpDir, "data.jsonl"));
    await store.appendLine({ v: 1 });
    await expect(store.readLines()).resolves.toEqual([{ v: 1 }]);
    // 第二次读命中缓存（无法直接观测，但至少结果必须一致）
    await expect(store.readLines()).resolves.toEqual([{ v: 1 }]);
    await store.appendLine({ v: 2 });
    await expect(store.readLines()).resolves.toEqual([{ v: 1 }, { v: 2 }]);
  });

  it("读缓存：进程外直接改文件（绕过 DocumentStore）后读到新数据", async () => {
    const store = new DocumentStore<{ v: number }>(path.join(tmpDir, "data.jsonl"));
    await store.appendLine({ v: 1 });
    await expect(store.readLines()).resolves.toEqual([{ v: 1 }]);
    // 模拟外部进程直写（尺寸变化保证 stat 指纹失效）
    await fs.writeFile(store.filePath, '{"v":10}\n{"v":20}\n', "utf-8");
    await expect(store.readLines()).resolves.toEqual([{ v: 10 }, { v: 20 }]);
  });

  it("读缓存：命中返回深拷贝，调用方原地修改不污染后续读取", async () => {
    const store = new DocumentStore<{ v: number }>(path.join(tmpDir, "data.jsonl"));
    await store.appendLine({ v: 1 });
    await store.appendLine({ v: 2 });
    const first = await store.readLines();
    first.splice(0, first.length); // 原地清空返回数组
    await expect(store.readLines()).resolves.toEqual([{ v: 1 }, { v: 2 }]);
  });

  it("读缓存：调用方原地修改记录字段，不污染缓存（scheduler runTask 模式）", async () => {
    // 回归背景：scheduler runTask 直接给 list() 返回的记录写字段再 update 回写；
    // 若缓存与返回值共享引用，内存改动会绕过写路径被后续读取看到（写还未落盘）
    const store = new DocumentStore<{ v: number; tag?: string }>(path.join(tmpDir, "data.jsonl"));
    await store.appendLine({ v: 1 });
    const records = await store.readLines();
    records[0]!.tag = "mutated-in-memory";
    const reread = await store.readLines();
    expect(reread).toEqual([{ v: 1 }]);
    expect(reread[0]!.tag).toBeUndefined();
  });

  it("读缓存：offset/limit 在缓存命中时语义不变", async () => {
    const store = new DocumentStore<{ v: number }>(path.join(tmpDir, "data.jsonl"));
    for (const v of [1, 2, 3, 4]) await store.appendLine({ v });
    await expect(store.readLines({ offset: 1, limit: 2 })).resolves.toEqual([{ v: 2 }, { v: 3 }]);
    // 第二次走缓存路径，结果必须一致
    await expect(store.readLines({ offset: 1, limit: 2 })).resolves.toEqual([{ v: 2 }, { v: 3 }]);
    await expect(store.readLines({ limit: 2 })).resolves.toEqual([{ v: 1 }, { v: 2 }]);
  });

  it("读缓存：同尺寸覆写（writeLines 相同字节数）也必须失效", async () => {
    // 回归背景：同尺寸写入可能 mtime 也相同（ms 精度），仅靠 stat 指纹会读到旧缓存
    const store = new DocumentStore<{ v: number }>(path.join(tmpDir, "data.jsonl"));
    await store.writeLines([{ v: 1 }]);
    await expect(store.readLines()).resolves.toEqual([{ v: 1 }]);
    await store.writeLines([{ v: 2 }]); // 与上一行字节数完全相同
    await expect(store.readLines()).resolves.toEqual([{ v: 2 }]);
  });

  it("读缓存：文件删除后返回空且不复活陈旧数据", async () => {
    const store = new DocumentStore<{ v: number }>(path.join(tmpDir, "data.jsonl"));
    await store.appendLine({ v: 1 });
    await expect(store.readLines()).resolves.toEqual([{ v: 1 }]);
    await fs.rm(store.filePath);
    await expect(store.readLines()).resolves.toEqual([]);
  });
});
