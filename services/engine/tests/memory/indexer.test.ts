import { describe, it, expect, vi } from "vitest";
import { MemoryIndexer } from "../../src/memory/indexer.js";
import type { EmbedderProvider } from "../../src/provider/types.js";
import type { SidecarClient } from "../../src/sidecar/client.js";

const SHORT_TIMEOUT_MS = 30;

function makeClient(overrides: Partial<SidecarClient> = {}): SidecarClient {
  return {
    isAvailable: async () => true,
    upsert: vi.fn(async () => true),
    search: vi.fn(async () => [{ id: "d1", score: 0.9 }]),
    countTokens: async () => 1,
    ...overrides,
  } as unknown as SidecarClient;
}

function makeEmbedder(impl?: EmbedderProvider["embed"]): EmbedderProvider {
  return {
    name: "fake",
    embed: impl ?? (async (texts: string[]) => texts.map(() => [0.1, 0.2])),
    supportsModel: () => true,
  };
}

describe("MemoryIndexer", () => {
  it("sidecar 距离在出口换算为相似度（similarity = 1 - distance，负值截断为 0）", async () => {
    const client = makeClient({
      search: vi.fn(async () => [
        { id: "close", score: 0.9 }, // 距离 0.9 → 相似度 0.1
        { id: "near", score: 0.05 }, // 距离 0.05 → 相似度 0.95
        { id: "far", score: 1.5 }, // 距离 1.5 → 相似度 0（截断）
      ]),
    });
    const indexer = new MemoryIndexer(client, makeEmbedder(), SHORT_TIMEOUT_MS);
    const hits = await indexer.search("a1", "query", 5);
    expect(hits.map((h) => h.id)).toEqual(["close", "near", "far"]);
    expect(hits[0]!.score).toBeCloseTo(0.1);
    expect(hits[1]!.score).toBeCloseTo(0.95);
    expect(hits[2]!.score).toBe(0);
  });

  it("indexMessage 正常路径调用 upsert", async () => {
    const client = makeClient();
    const indexer = new MemoryIndexer(client, makeEmbedder(), SHORT_TIMEOUT_MS);
    await indexer.indexMessage("a1", "d1", "hello world");
    expect(client.upsert).toHaveBeenCalledWith("a1", "d1", [0.1, 0.2]);
  });

  it("embed 挂起时 search 在超时后降级返回 []，不卡聊天主链路", async () => {
    const hanging = makeEmbedder(() => new Promise<number[][]>(() => {}));
    const indexer = new MemoryIndexer(makeClient(), hanging, SHORT_TIMEOUT_MS);
    const start = Date.now();
    const hits = await indexer.search("a1", "query", 5);
    expect(hits).toEqual([]);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("embed 挂起时 indexMessage 在超时后静默跳过（不 upsert、不挂起）", async () => {
    const client = makeClient();
    const hanging = makeEmbedder(() => new Promise<number[][]>(() => {}));
    const indexer = new MemoryIndexer(client, hanging, SHORT_TIMEOUT_MS);
    const start = Date.now();
    // console.error 会被调用，静音掉避免污染测试输出
    const silent = vi.spyOn(console, "error").mockImplementation(() => {});
    await indexer.indexMessage("a1", "d1", "hello world");
    expect(Date.now() - start).toBeLessThan(2000);
    expect(client.upsert).not.toHaveBeenCalled();
    silent.mockRestore();
  });

  it("sidecar 不可用时直接降级，不调用 embed", async () => {
    const client = makeClient({ isAvailable: async () => false });
    const embed = vi.fn(async (texts: string[]) => texts.map(() => [0.1]));
    const indexer = new MemoryIndexer(client, makeEmbedder(embed), SHORT_TIMEOUT_MS);
    expect(await indexer.search("a1", "query", 5)).toEqual([]);
    await indexer.indexMessage("a1", "d1", "hello");
    expect(embed).not.toHaveBeenCalled();
  });
});
