import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MemoryIndexer } from "../../src/memory/indexer.js";
import type { ChatMessageRecord, IMessageRepository } from "../../src/memory/repositories/types.js";
import { writeCompressedTopic } from "../../src/memory/topic/store.js";
import { restoreDataDir } from "../helpers/env.js";
import {
  SemanticRetriever,
  normalizeSemanticSearchConfig,
  timeDecay,
  DEFAULT_SEMANTIC_SEARCH_CONFIG,
} from "../../src/context/semantic.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-07-21T00:00:00.000Z");

describe("timeDecay 分段衰减", () => {
  it("一周内不衰减", () => {
    expect(timeDecay(new Date(NOW - 6 * DAY).toISOString(), NOW)).toBe(1.0);
    expect(timeDecay(new Date(NOW).toISOString(), NOW)).toBe(1.0);
  });

  it("一个月内 0.8", () => {
    expect(timeDecay(new Date(NOW - 8 * DAY).toISOString(), NOW)).toBe(0.8);
    expect(timeDecay(new Date(NOW - 29 * DAY).toISOString(), NOW)).toBe(0.8);
  });

  it("三个月内 0.5", () => {
    expect(timeDecay(new Date(NOW - 40 * DAY).toISOString(), NOW)).toBe(0.5);
  });

  it("三个月以上保底 0.3", () => {
    expect(timeDecay(new Date(NOW - 365 * DAY).toISOString(), NOW)).toBe(0.3);
  });

  it("无法解析的时间按不衰减处理", () => {
    expect(timeDecay("not-a-date", NOW)).toBe(1.0);
  });
});

describe("normalizeSemanticSearchConfig", () => {
  afterEach(() => vi.restoreAllMocks());

  it("缺省返回默认配置", () => {
    expect(normalizeSemanticSearchConfig()).toEqual(DEFAULT_SEMANTIC_SEARCH_CONFIG);
  });

  it("topK < 1 回退默认并 warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(normalizeSemanticSearchConfig({ topK: 0 }).topK).toBe(DEFAULT_SEMANTIC_SEARCH_CONFIG.topK);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("minScore 超出 [0,1] 被截断", () => {
    expect(normalizeSemanticSearchConfig({ minScore: -0.5 }).minScore).toBe(0);
    expect(normalizeSemanticSearchConfig({ minScore: 2 }).minScore).toBe(1);
  });

  it("NaN 与非法输入被归一", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(normalizeSemanticSearchConfig({ topK: Number.NaN }).topK).toBe(
      DEFAULT_SEMANTIC_SEARCH_CONFIG.topK,
    );
    expect(warn).toHaveBeenCalledOnce();
    expect(normalizeSemanticSearchConfig({ minScore: Number.NaN }).minScore).toBe(0);
    expect(normalizeSemanticSearchConfig({ topK: 4.7 }).topK).toBe(4);
    expect(normalizeSemanticSearchConfig({ topK: 1 }).topK).toBe(1);
    expect(normalizeSemanticSearchConfig({ minScore: 1 }).minScore).toBe(1);
  });
});

// ---- SemanticRetriever ----

function rec(id: string, text: string, createdAt: string, sessionId = "default"): ChatMessageRecord {
  return { id, sessionId, role: "user", content: [{ type: "text", text }], createdAt };
}

// 注意：mock 的是 MemoryIndexer 出口——已换算为相似度（大 = 更相关）。
// sidecar 原始返回是距离（小 = 更近），换算见 src/memory/indexer.ts
// 与 tests/memory/indexer.test.ts，勿按距离语义写本文件的期望值。
function makeIndexer(hits: { id: string; score: number }[]): MemoryIndexer {
  return { search: vi.fn(async () => hits) } as unknown as MemoryIndexer;
}

function makeRepo(records: ChatMessageRecord[]): IMessageRepository {
  return {
    append: async () => {},
    listBySession: async () => [],
    getByIds: async (ids: string[]) => records.filter((r) => ids.includes(r.id)),
    archiveAndRemove: async () => {},
    getArchivedByIds: async () => [],
  };
}

const config = { enabled: true, topK: 3, minScore: 0 };

describe("SemanticRetriever", () => {
  // 钉住系统时间（review M10 顺手修的时间炸弹）：retrieve 内部 timeDecay 用真实
  // Date.now()，而造消息用固定 NOW——真实时间跨过 7 天档线后衰减档位漂移、测试
  // 周期性爆炸。用 fake timers 把"现在"钉在 NOW，档位判定永不随真实时间漂移。
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("相似度 × 时间衰减打分并按降序返回", async () => {
    const indexer = makeIndexer([
      { id: "new-low", score: 0.5 },
      { id: "old-high", score: 0.9 },
    ]);
    const repo = makeRepo([
      rec("new-low", "新但低相关", new Date(NOW - 1 * DAY).toISOString()),
      rec("old-high", "旧但高相关", new Date(NOW - 100 * DAY).toISOString()),
    ]);
    const r = new SemanticRetriever(indexer, repo, config);
    const out = await r.retrieve("a1", "query", new Set(), "default");

    // new-low: 0.5 × 1.0 = 0.5；old-high: 0.9 × 0.3 = 0.27 → 新的排前
    expect(out.map((m) => m.id)).toEqual(["new-low", "old-high"]);
    expect(out[0]!.score).toBeCloseTo(0.5);
    expect(out[1]!.score).toBeCloseTo(0.27);
  });

  it("时间衰减档位随钉住的系统时间正确切换（7 天档线两侧）", async () => {
    const indexer = makeIndexer([{ id: "m", score: 0.5 }]);
    const createdAt = new Date(NOW - 1 * DAY).toISOString();
    const r = new SemanticRetriever(indexer, makeRepo([rec("m", "内容", createdAt)]), config);

    // 钉在 NOW：消息 1 天前，一周内档 1.0
    expect((await r.retrieve("a1", "q", new Set(), "default"))[0]!.score).toBeCloseTo(0.5);
    // 系统时间前进 7 天：消息 8 天前，滑入一月内档 0.8
    vi.setSystemTime(NOW + 7 * DAY);
    expect((await r.retrieve("a1", "q", new Set(), "default"))[0]!.score).toBeCloseTo(0.4);
    // 再前进 100 天：三个月以上保底档 0.3
    vi.setSystemTime(NOW + 107 * DAY);
    expect((await r.retrieve("a1", "q", new Set(), "default"))[0]!.score).toBeCloseTo(0.15);
  });

  it("排除当前历史已含消息（去重）", async () => {
    const indexer = makeIndexer([
      { id: "in-history", score: 0.9 },
      { id: "fresh", score: 0.8 },
    ]);
    const repo = makeRepo([rec("in-history", "已在历史", new Date(NOW).toISOString()), rec("fresh", "新的", new Date(NOW).toISOString())]);
    const r = new SemanticRetriever(indexer, repo, config);
    const out = await r.retrieve("a1", "q", new Set(["in-history"]), "default");
    expect(out.map((m) => m.id)).toEqual(["fresh"]);
  });

  it("排除已压缩话题的原始消息（Phase 2 衔接，依压缩档 msg_ids）", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "semantic-archived-test-"));
    const originalDataDir = process.env.CLOUDMIND_DATA_DIR;
    process.env.CLOUDMIND_DATA_DIR = tmpDir;
    try {
      // "archived" 已是某压缩话题的原文（摘要在 L5）
      await writeCompressedTopic("a1", {
        topicId: "tp_1000_test",
        label: "旧话题",
        summary: "摘要",
        keyPoints: [],
        msgIds: ["archived"],
        msgCount: 1,
        importance: "normal",
        sourceId: "default",
        compressedAt: new Date().toISOString(),
      });

      const indexer = makeIndexer([
        { id: "archived", score: 0.95 },
        { id: "alive", score: 0.8 },
      ]);
      const repo = makeRepo([
        rec("archived", "已归档原文", new Date(NOW).toISOString()),
        rec("alive", "未归档", new Date(NOW).toISOString()),
      ]);
      const r = new SemanticRetriever(indexer, repo, config);
      const out = await r.retrieve("a1", "q", new Set(), "default");
      expect(out.map((m) => m.id)).toEqual(["alive"]);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
      restoreDataDir(originalDataDir);
    }
  });

  it("跨场景命中标注 source，同场景不标注", async () => {
    const indexer = makeIndexer([
      { id: "same", score: 0.9 },
      { id: "cross", score: 0.8 },
    ]);
    const repo = makeRepo([
      rec("same", "同场景", new Date(NOW).toISOString(), "s1"),
      rec("cross", "跨场景", new Date(NOW).toISOString(), "s2"),
    ]);
    const r = new SemanticRetriever(indexer, repo, config);
    const out = await r.retrieve("a1", "q", new Set(), "s1");
    expect(out.find((m) => m.id === "same")!.source).toBeUndefined();
    expect(out.find((m) => m.id === "cross")!.source).toBe("s2");
  });

  it("minScore 过滤低相关结果", async () => {
    const indexer = makeIndexer([
      { id: "high", score: 0.9 },
      { id: "low", score: 0.4 },
    ]);
    const repo = makeRepo([
      rec("high", "高相关", new Date(NOW - 100 * DAY).toISOString()), // 0.9×0.3=0.27
      rec("low", "低相关", new Date(NOW).toISOString()), // 0.4×1.0=0.4
    ]);
    const r = new SemanticRetriever(indexer, repo, { ...config, minScore: 0.35 });
    const out = await r.retrieve("a1", "q", new Set(), "default");
    expect(out.map((m) => m.id)).toEqual(["low"]);
  });

  it("topK 截断且候选放大一倍", async () => {
    const hits = Array.from({ length: 6 }, (_, i) => ({ id: `m${i}`, score: 0.9 - i * 0.1 }));
    const indexer = makeIndexer(hits);
    const repo = makeRepo(hits.map((h) => rec(h.id, `内容${h.id}`, new Date(NOW).toISOString())));
    const r = new SemanticRetriever(indexer, repo, config);
    const out = await r.retrieve("a1", "q", new Set(), "default");
    expect(out).toHaveLength(3);
    expect(indexer.search).toHaveBeenCalledWith("a1", "q", 6);
  });

  it("enabled=false / 空 query 直接返回空且不发起检索", async () => {
    const indexer = makeIndexer([{ id: "x", score: 1 }]);
    const repo = makeRepo([rec("x", "内容", new Date(NOW).toISOString())]);
    const disabled = new SemanticRetriever(indexer, repo, { ...config, enabled: false });
    expect(await disabled.retrieve("a1", "q", new Set(), "default")).toEqual([]);

    const empty = new SemanticRetriever(indexer, repo, config);
    expect(await empty.retrieve("a1", "   ", new Set(), "default")).toEqual([]);
    expect(indexer.search).not.toHaveBeenCalled();
  });

  it("无候选命中时返回空数组", async () => {
    const indexer = makeIndexer([]);
    const repo = makeRepo([]);
    const r = new SemanticRetriever(indexer, repo, config);
    expect(await r.retrieve("a1", "q", new Set(), "default")).toEqual([]);
  });

  it("注入内容按 2000 字符截断（与索引侧一致）", async () => {
    const indexer = makeIndexer([{ id: "big", score: 0.9 }]);
    const repo = makeRepo([rec("big", "x".repeat(5000), new Date(NOW).toISOString())]);
    const r = new SemanticRetriever(indexer, repo, config);
    const out = await r.retrieve("a1", "q", new Set(), "default");
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toHaveLength(2000);
  });

  it("索引命中但 repo 查无此条：静默跳过", async () => {
    const indexer = makeIndexer([
      { id: "ghost", score: 0.99 },
      { id: "real", score: 0.8 },
    ]);
    const repo = makeRepo([rec("real", "存在", new Date(NOW).toISOString())]);
    const r = new SemanticRetriever(indexer, repo, config);
    const out = await r.retrieve("a1", "q", new Set(), "default");
    expect(out.map((m) => m.id)).toEqual(["real"]);
  });
});
