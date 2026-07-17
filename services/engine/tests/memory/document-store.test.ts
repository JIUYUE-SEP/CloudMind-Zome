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
});
