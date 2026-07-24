import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentConfig } from "@mindcloud/shared";
import { DocumentStore } from "../src/memory/document-store.js";
import {
  MigrationChain,
  UnsupportedSchemaVersionError,
} from "../src/versioning.js";
import { ConfigRepository } from "../src/config/repository.js";
import { AgentRepository } from "../src/memory/repositories/agent.js";
import {
  archivedMessageIds,
  compressedDir,
  latestSummaries,
  writeCompressedTopic,
} from "../src/memory/topic/store.js";
import type { CompressedTopic } from "../src/memory/topic/types.js";
import { appendMindExperiences, parseMindChunks } from "../src/mind/mind-files.js";
import { restoreDataDir } from "./helpers/env.js";

/**
 * P1-1 落盘格式版本字段与迁移机制（数据 review M4）：
 * - 无版本字段的旧文件一律按 v1 正常读取（现存数据全是 v1）
 * - 版本高于当前代码认识的版本 → 显式报错（不静默读空）
 * - 迁移函数注册表（vN → vN+1 链）读时惰性迁移
 * - 各格式写入路径现在都带版本字段
 */

describe("落盘格式版本（P1-1）", () => {
  let tmpDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "schema-version-test-"));
    originalDataDir = process.env.CLOUDMIND_DATA_DIR;
    process.env.CLOUDMIND_DATA_DIR = tmpDir;
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    restoreDataDir(originalDataDir);
  });

  describe("JSONL（DocumentStore）", () => {
    it("无版本字段的旧文件按 v1 正常读，读出记录不含版本字段", async () => {
      const file = path.join(tmpDir, "old.jsonl");
      // 现存数据的真实形态：没有任何版本字段
      await fs.writeFile(file, '{"id":"a","n":1}\n{"id":"b","n":2}\n', "utf-8");
      const store = new DocumentStore<{ id: string; n: number }>(file);
      await expect(store.readLines()).resolves.toEqual([
        { id: "a", n: 1 },
        { id: "b", n: 2 },
      ]);
    });

    it("appendLine / writeLines 写入路径带版本字段", async () => {
      const file = path.join(tmpDir, "stamped.jsonl");
      const store = new DocumentStore<{ id: string }>(file);
      await store.appendLine({ id: "a" });
      await store.writeLines([{ id: "b" }, { id: "c" }]);
      const lines = (await fs.readFile(file, "utf-8"))
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(lines).toEqual([
        { id: "b", schemaVersion: 1 },
        { id: "c", schemaVersion: 1 },
      ]);
      // 读回时版本字段被剥离，业务记录不带 schemaVersion
      await expect(store.readLines()).resolves.toEqual([{ id: "b" }, { id: "c" }]);
    });

    it("高版本行显式报错，不静默读空", async () => {
      const file = path.join(tmpDir, "too-new.jsonl");
      await fs.writeFile(file, '{"id":"a","schemaVersion":99}\n', "utf-8");
      const store = new DocumentStore<{ id: string }>(file);
      await expect(store.readLines()).rejects.toThrow(UnsupportedSchemaVersionError);
      await expect(store.readLines()).rejects.toThrow(/版本过高/);
    });

    it("mutateLines 写回时把旧格式文件物理升级为当前版本", async () => {
      const file = path.join(tmpDir, "upgrade.jsonl");
      await fs.writeFile(file, '{"id":"a"}\n{"id":"b"}\n', "utf-8");
      const store = new DocumentStore<{ id: string }>(file);
      await store.mutateLines((rs) => rs); // 原样写回
      const lines = (await fs.readFile(file, "utf-8"))
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(lines).toEqual([
        { id: "a", schemaVersion: 1 },
        { id: "b", schemaVersion: 1 },
      ]);
    });

    it("迁移机制：注册 v1→v2 示例迁移，读旧数据时被逐级迁移（混合版本文件）", async () => {
      type Rec = { id: string; text?: string; content?: string };
      // v1→v2 示例迁移：text 字段改名 content（第一次真实格式变更时的典型形态）
      const chain = new MigrationChain<Rec>(2).register(1, (d) => ({
        id: d.id,
        content: d.text ?? "",
      }));
      const file = path.join(tmpDir, "mixed.jsonl");
      // append-only 文件升级后的真实形态：v1 旧行与 v2 新行混排
      await fs.writeFile(
        file,
        JSON.stringify({ id: "old", text: "hello" }) +
          "\n" +
          JSON.stringify({ id: "new", content: "world", schemaVersion: 2 }) +
          "\n",
        "utf-8",
      );
      const store = new DocumentStore<Rec>(file, chain);
      await expect(store.readLines()).resolves.toEqual([
        { id: "old", content: "hello" }, // v1 行被迁移
        { id: "new", content: "world" }, // v2 行原样
      ]);
      // 升级后的写入路径盖 v2 版本戳
      await store.appendLine({ id: "fresh", content: "x" });
      expect(await fs.readFile(file, "utf-8")).toContain('"schemaVersion":2');
    });

    it("迁移链缺环节显式报错（注册表残缺不静默）", async () => {
      type Rec = { id: string };
      // current=3 但只注册了 v2→v3，缺 v1→v2
      const chain = new MigrationChain<Rec>(3).register(2, (d) => d);
      const file = path.join(tmpDir, "broken-chain.jsonl");
      await fs.writeFile(file, '{"id":"a"}\n', "utf-8");
      const store = new DocumentStore<Rec>(file, chain);
      await expect(store.readLines()).rejects.toThrow(/迁移链缺环节/);
    });

    it("register 拒绝非法的版本号", () => {
      expect(() => new MigrationChain(1).register(1, (d) => d)).toThrow(
        /invalid migration step/,
      );
    });
  });

  describe("单文件 JSON（DocumentStore）", () => {
    it("writeJson 带版本字段；readJson 读出时剥离版本字段", async () => {
      const file = path.join(tmpDir, "one.json");
      const store = new DocumentStore<{ name: string }>(file);
      await store.writeJson({ name: "x" });
      const raw = JSON.parse(await fs.readFile(file, "utf-8")) as Record<string, unknown>;
      expect(raw.schemaVersion).toBe(1);
      await expect(store.readJson()).resolves.toEqual({ name: "x" });
    });

    it("无版本字段的旧文件按 v1 正常读；高版本显式报错", async () => {
      const file = path.join(tmpDir, "agent-like.json");
      const store = new DocumentStore<{ name: string }>(file);
      await fs.writeFile(file, JSON.stringify({ name: "old" }), "utf-8");
      await expect(store.readJson()).resolves.toEqual({ name: "old" });

      await fs.writeFile(file, JSON.stringify({ name: "new", schemaVersion: 99 }), "utf-8");
      await expect(store.readJson()).rejects.toThrow(UnsupportedSchemaVersionError);
    });
  });

  describe("config.json", () => {
    const bareConfig = {
      providers: [],
      settings: {
        memory: { compactThreshold: 0.8, keepRecent: 3, hotMemoryLimit: 10, warmMemoryLimit: 20 },
      },
    };

    it("save 写入带版本字段", async () => {
      const repo = new ConfigRepository();
      await repo.save(bareConfig);
      const raw = JSON.parse(
        await fs.readFile(path.join(tmpDir, "config.json"), "utf-8"),
      ) as Record<string, unknown>;
      expect(raw.schemaVersion).toBe(1);
    });

    it("无版本字段的旧配置按 v1 正常 load", async () => {
      await fs.writeFile(path.join(tmpDir, "config.json"), JSON.stringify(bareConfig), "utf-8");
      const repo = new ConfigRepository();
      const loaded = await repo.load();
      expect(loaded.providers).toEqual([]);
      expect(loaded.settings.memory.keepRecent).toBe(3);
    });

    it("高版本配置显式报错，且不隔离、不改动原文件", async () => {
      const high = JSON.stringify({ schemaVersion: 99, ...bareConfig });
      const filePath = path.join(tmpDir, "config.json");
      await fs.writeFile(filePath, high, "utf-8");
      const repo = new ConfigRepository();
      await expect(repo.load()).rejects.toThrow(UnsupportedSchemaVersionError);
      // 文件没坏、是代码太旧：不走损坏隔离，文件原样保留
      expect(await fs.readFile(filePath, "utf-8")).toBe(high);
    });
  });

  describe("agent.json", () => {
    it("save 写入带版本字段；get 读出不带版本字段", async () => {
      const repo = new AgentRepository();
      const config = { id: "a1", name: "A", persona: "p", skills: [], tools: [] } as AgentConfig;
      await repo.save("a1", config);
      const raw = JSON.parse(
        await fs.readFile(path.join(tmpDir, "agents", "a1", "agent.json"), "utf-8"),
      ) as Record<string, unknown>;
      expect(raw.schemaVersion).toBe(1);
      const got = await repo.get("a1");
      expect(got?.name).toBe("A");
      expect(got).not.toHaveProperty("schemaVersion");
      repo.dispose();
    });

    it("高版本 agent.json 让 list() 显式报错，而不是静默从列表消失", async () => {
      const dir = path.join(tmpDir, "agents", "new-agent");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, "agent.json"),
        JSON.stringify({ schemaVersion: 99, name: "X", persona: "p", skills: [], tools: [] }),
        "utf-8",
      );
      const repo = new AgentRepository();
      await expect(repo.list()).rejects.toThrow(UnsupportedSchemaVersionError);
      repo.dispose();
    });
  });

  describe("_compressed/{topicId}.md", () => {
    function makeTopic(overrides: Partial<CompressedTopic> = {}): CompressedTopic {
      return {
        topicId: "tp_1000_aaaa",
        label: "测试话题",
        summary: "摘要",
        keyPoints: ["要点"],
        msgIds: ["m1", "m2"],
        msgCount: 2,
        importance: "normal",
        sourceId: "s1",
        sourceName: "私聊",
        compressedAt: "2026-07-24T00:00:00.000Z",
        ...overrides,
      };
    }

    it("写入带 schema: 1；无 schema 的旧档按 v1 正常解析", async () => {
      await writeCompressedTopic("a1", makeTopic());
      const filePath = path.join(compressedDir("a1"), "tp_1000_aaaa.md");
      const raw = await fs.readFile(filePath, "utf-8");
      expect(raw).toContain("schema: 1");

      // 旧档（无 schema 行）正常解析
      const oldRaw = raw.replace(/^schema: 1\n/m, "");
      await fs.writeFile(path.join(compressedDir("a1"), "tp_2000_bbbb.md"), oldRaw, "utf-8");
      const summaries = await latestSummaries("a1", 10);
      expect(summaries).toHaveLength(2);
      expect(await archivedMessageIds("a1")).toEqual(new Set(["m1", "m2"]));
    });

    it("高版本档：latestSummaries 与 archivedMessageIds 显式报错，不按坏档静默跳过", async () => {
      await writeCompressedTopic("a1", makeTopic());
      const raw = await fs.readFile(path.join(compressedDir("a1"), "tp_1000_aaaa.md"), "utf-8");
      await fs.writeFile(
        path.join(compressedDir("a1"), "tp_3000_cccc.md"),
        raw.replace("schema: 1", "schema: 99"),
        "utf-8",
      );
      await expect(latestSummaries("a1", 10)).rejects.toThrow(UnsupportedSchemaVersionError);
      await expect(archivedMessageIds("a1")).rejects.toThrow(UnsupportedSchemaVersionError);
    });
  });

  describe("MIND.md", () => {
    it("新经验块带 schema: 1", async () => {
      await appendMindExperiences("a1", [
        {
          title: "偏好：不用 emoji",
          text: "指挥官明确表示不用 emoji。",
          confidence: 0.9,
          source: "topic-tp_1",
          created: "2026-07-24T00:00:00Z",
        },
      ]);
      const raw = await fs.readFile(path.join(tmpDir, "agents", "a1", "MIND.md"), "utf-8");
      expect(raw).toContain("schema: 1");
      expect(raw).toContain("source: topic-tp_1");
    });

    it("无 schema 的旧块按 v1 正常解析", () => {
      const chunks = parseMindChunks(
        "## 旧经验\n---\nsource: topic-tp_0\ncreated: 2026-01-01T00:00:00Z\nconfidence: 0.9\n---\n旧正文\n",
      );
      expect(chunks).toHaveLength(1);
      expect(chunks[0].source).toBe("topic-tp_0");
      expect(chunks[0].content).toBe("旧正文");
    });

    it("高版本经验块显式报错", () => {
      expect(() =>
        parseMindChunks("## 新格式经验\n---\nschema: 99\nsource: topic-tp_9\n---\n正文\n"),
      ).toThrow(UnsupportedSchemaVersionError);
    });
  });
});
