import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ToolBlurbStore, descHashOf, type ToolBlurbEntry } from "../../src/core/tool-blurb-store.js";

let tmpDir: string;
let filePath: string;
let store: ToolBlurbStore;

function entry(blurb: string, descHash = "h1", source: "llm" | "user" = "llm"): ToolBlurbEntry {
  return { blurb, descHash, source, updatedAt: "2026-08-26T00:00:00.000Z" };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tool-blurb-store-"));
  filePath = path.join(tmpDir, "tool-blurbs.json");
  store = new ToolBlurbStore(filePath);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("ToolBlurbStore（spec 决策 2：只存 blurb+哈希+source+时间）", () => {
  it("descHashOf：sha1 截 12，同文同哈希、异文异哈希", () => {
    expect(descHashOf("hello")).toHaveLength(12);
    expect(descHashOf("hello")).toBe(descHashOf("hello"));
    expect(descHashOf("hello")).not.toBe(descHashOf("world"));
  });

  it("空态：文件不存在 getAll 返回空表、get 返回 undefined", async () => {
    expect(await store.getAll()).toEqual({});
    expect(await store.get("mcp__a__t")).toBeUndefined();
  });

  it("upsert 写读回环 + 合并：二次 upsert 保留旧键、覆盖同键", async () => {
    await store.upsert([["mcp__a__t1", entry("读文件", "h1")]]);
    await store.upsert([
      ["mcp__a__t2", entry("写文件", "h2")],
      ["mcp__a__t1", entry("读取文件", "h1b")],
    ]);
    const all = await store.getAll();
    expect(Object.keys(all).sort()).toEqual(["mcp__a__t1", "mcp__a__t2"]);
    expect(all["mcp__a__t1"]!.blurb).toBe("读取文件");
    expect(all["mcp__a__t1"]!.descHash).toBe("h1b");
    expect(all["mcp__a__t2"]!.blurb).toBe("写文件");
    expect((await store.get("mcp__a__t2"))!.source).toBe("llm");
    // 落盘不存描述原文：文件里只有四个字段
    const raw = JSON.parse(await fs.readFile(filePath, "utf-8"));
    for (const key of Object.keys(raw)) {
      if (key === "schemaVersion") continue;
      expect(Object.keys(raw[key]).sort()).toEqual(["blurb", "descHash", "source", "updatedAt"]);
    }
  });

  it("user source 条目照常存取（覆盖规则在调用方，本层只管存取）", async () => {
    await store.upsert([["mcp__a__t1", entry("用户改的", "h1", "user")]]);
    expect((await store.get("mcp__a__t1"))!.source).toBe("user");
  });

  it("损坏隔离：坏 JSON → 空态启动 + .corrupt- 备份，不静默覆盖", async () => {
    await fs.writeFile(filePath, "{not json!!!", "utf-8");
    expect(await store.getAll()).toEqual({});
    const siblings = await fs.readdir(tmpDir);
    const quarantined = siblings.filter((f) => f.startsWith("tool-blurbs.json.corrupt-"));
    expect(quarantined).toHaveLength(1);
    // 原路径已不存在（后续 save 重建干净文件）
    await expect(fs.access(filePath)).rejects.toThrow();
    // 空态后可正常写入
    await store.upsert([["mcp__a__t1", entry("x")]]);
    expect((await store.get("mcp__a__t1"))!.blurb).toBe("x");
  });
});
