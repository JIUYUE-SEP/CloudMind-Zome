import { logger } from "../../src/logger.js";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LLMProvider, LLMEvent } from "../../src/provider/types.js";
import { MessageRepository } from "../../src/memory/repositories/message.js";
import { MemoryRepository } from "../../src/memory/repositories/memory.js";
import type { ChatMessageRecord } from "../../src/memory/repositories/types.js";
import { runCompressionTask, type CompressionTaskDeps } from "../../src/memory/topic/compression-task.js";
import { compressedDir } from "../../src/memory/topic/store.js";
import type { TopicSegment } from "../../src/memory/topic/types.js";
import { restoreDataDir } from "../helpers/env.js";

// P4-a memory flush：压缩调用同次产出的长期记忆事实，在归档成功后落
// memories.jsonl（首个生产写入方）+ 向量索引（doc_id `mem:<recordId>`，L4 可召回）。
// 纪律与 M12 经验沉淀同型：归档失败不写（无孤儿）；写库/索引失败仅 warn 不炸主流程。
class FixedReplyProvider implements LLMProvider {
  name = "fixed";
  constructor(private reply: string) {}
  supportsModel() {
    return true;
  }
  async *chat(): AsyncIterable<LLMEvent> {
    yield { type: "text.delta", delta: this.reply };
    yield { type: "step.end" };
  }
}

function makeMsg(id: string): ChatMessageRecord {
  return {
    id,
    sessionId: "s1",
    role: "user",
    content: [{ type: "text", text: `消息 ${id}` }],
    createdAt: "2026-07-24T10:00:00.000Z",
  };
}

function makeSegment(ids: string[]): TopicSegment {
  return {
    topicId: "tp_p4a_flush",
    messages: ids.map(makeMsg),
    sourceId: "s1",
    startedAt: "2026-07-24T10:00:00.000Z",
    endedAt: "2026-07-24T10:05:00.000Z",
  };
}

/** 压缩回复带两条高置信事实 + 一条 ≤0.5（不落盘）+ 重要性 high（复核 prompt 同回复解析失败按单话题回退，属现状口径） */
const REPLY_WITH_FACTS = [
  "话题主题：部署决策",
  "关键结论：",
  "- 决定用方案 C",
  "经验：",
  "长期记忆：",
  "- 指挥官拍板用方案 C | 0.9",
  "- 部署窗口在周五晚上 | 0.8",
  "- 低置信事实不落盘 | 0.5",
  "重要性：high",
].join("\n");

const REPLY_NO_FACTS = "话题主题：常规\n关键结论：\n- 结论\n经验：\n长期记忆：\n重要性：normal";

describe("runCompressionTask memory flush（P4-a）", () => {
  let tmpDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "compression-flush-test-"));
    originalDataDir = process.env.CLOUDMIND_DATA_DIR;
    process.env.CLOUDMIND_DATA_DIR = tmpDir;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
    restoreDataDir(originalDataDir);
  });

  function makeDeps(
    repo: MessageRepository,
    reply: string,
  ): {
    deps: CompressionTaskDeps;
    indexMemory: ReturnType<typeof vi.fn>;
  } {
    const indexMemory = vi.fn(async () => {});
    return {
      deps: {
        agentId: "a1",
        provider: new FixedReplyProvider(reply),
        model: "mock",
        messageRepository: repo,
        mind: {
          appendMindExperiences: async () => ({ appended: 0, merged: 0, skipped: 0 }),
          isInjectionSuspect: () => false,
        },
        memoryRepository: new MemoryRepository("a1"),
        indexMemory,
      },
      indexMemory,
    };
  }

  it("归档成功后 flush：>0.5 事实逐条落 memories.jsonl + 索引（≤0.5 不落盘）", async () => {
    const ids = ["m1", "m2", "m3", "m4"];
    const repo = new MessageRepository("a1");
    for (const id of ids) await repo.append(makeMsg(id));
    const { deps, indexMemory } = makeDeps(repo, REPLY_WITH_FACTS);
    const order: string[] = [];
    const origArchive = repo.archiveAndRemove.bind(repo);
    vi.spyOn(repo, "archiveAndRemove").mockImplementation(async (msgIds: string[]) => {
      order.push("archive");
      return origArchive(msgIds);
    });
    indexMemory.mockImplementation(async () => {
      order.push("index");
    });

    await runCompressionTask(makeSegment(ids), deps);

    // M12 同型纪律：flush 在归档成功之后
    expect(order[0]).toBe("archive");
    expect(order.filter((s) => s === "index")).toHaveLength(2);

    // 落库两条（0.5 的不落盘），字段齐：content=事实文本、embeddingId=mem:<recordId>、置信度随记录落盘（R2 可审计）
    const memories = await new MemoryRepository("a1").list();
    expect(memories).toHaveLength(2);
    expect(memories.map((m) => m.content)).toEqual(["指挥官拍板用方案 C", "部署窗口在周五晚上"]);
    expect(memories.map((m) => m.confidence)).toEqual([0.9, 0.8]);
    for (const m of memories) {
      expect(m.id).toMatch(/^mem_/);
      expect(m.embeddingId).toBe(`mem:${m.id}`);
      expect(m.createdAt).toBeTruthy();
    }
    // 索引 doc_id 约定：mem:<recordId>（由装配方拼前缀，此处验证 recordId 直通钩子）
    expect(indexMemory.mock.calls.map((c) => c[0]).sort()).toEqual(
      memories.map((m) => m.id).sort(),
    );
    expect(indexMemory.mock.calls.map((c) => c[1]).sort()).toEqual(
      memories.map((m) => m.content).sort(),
    );
    // 主流程结果不变：落档 + 归档
    expect(await repo.listBySession("s1")).toEqual([]);
    const files = await fs.readdir(compressedDir("a1"));
    expect(files.filter((f) => f.endsWith(".md"))).toHaveLength(1);
  });

  it("importance 真值进压缩档 frontmatter（重要性：high → importance: high）", async () => {
    const ids = ["m1", "m2", "m3", "m4"];
    const repo = new MessageRepository("a1");
    for (const id of ids) await repo.append(makeMsg(id));
    const { deps } = makeDeps(repo, REPLY_WITH_FACTS);

    await runCompressionTask(makeSegment(ids), deps);

    const raw = await fs.readFile(path.join(compressedDir("a1"), "tp_p4a_flush.md"), "utf-8");
    expect(raw).toContain("importance: high");
  });

  it("无 indexMemory 钩子（Mock embedder 无索引器）：写库照做、只跳过向量", async () => {
    const ids = ["m1", "m2", "m3", "m4"];
    const repo = new MessageRepository("a1");
    for (const id of ids) await repo.append(makeMsg(id));
    const { deps } = makeDeps(repo, REPLY_WITH_FACTS);
    deps.indexMemory = undefined;

    await runCompressionTask(makeSegment(ids), deps);

    const memories = await new MemoryRepository("a1").list();
    expect(memories).toHaveLength(2);
  });

  it("无可沉事实（长期记忆区空）：不写库不索引，主流程不变", async () => {
    const ids = ["m1", "m2", "m3", "m4"];
    const repo = new MessageRepository("a1");
    for (const id of ids) await repo.append(makeMsg(id));
    const { deps, indexMemory } = makeDeps(repo, REPLY_NO_FACTS);

    await runCompressionTask(makeSegment(ids), deps);

    expect(indexMemory).not.toHaveBeenCalled();
    expect(await new MemoryRepository("a1").list()).toEqual([]);
    expect(await repo.listBySession("s1")).toEqual([]);
  });

  it("归档失败：不 flush（无孤儿事实），压缩档隔离、消息留热存储", async () => {
    const ids = ["m1", "m2", "m3", "m4"];
    const repo = new MessageRepository("a1");
    for (const id of ids) await repo.append(makeMsg(id));
    const { deps, indexMemory } = makeDeps(repo, REPLY_WITH_FACTS);
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    vi.spyOn(repo, "archiveAndRemove").mockRejectedValue(new Error("disk full"));

    await expect(runCompressionTask(makeSegment(ids), deps)).rejects.toThrow("disk full");

    expect(indexMemory).not.toHaveBeenCalled();
    expect(await new MemoryRepository("a1").list()).toEqual([]);
    expect(await fs.readdir(compressedDir("a1")).catch(() => [])).toEqual([]);
    expect((await repo.listBySession("s1")).map((m) => m.id)).toEqual(ids);
  });

  it("写库失败仅 warn 跳过该条：其余事实照常落库，主流程不炸", async () => {
    const ids = ["m1", "m2", "m3", "m4"];
    const repo = new MessageRepository("a1");
    for (const id of ids) await repo.append(makeMsg(id));
    const { deps, indexMemory } = makeDeps(repo, REPLY_WITH_FACTS);
    let calls = 0;
    deps.memoryRepository = {
      list: async () => [],
      append: async () => {
        calls += 1;
        if (calls === 1) throw new Error("disk full");
      },
    };
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    await runCompressionTask(makeSegment(ids), deps);

    // 两条 >0.5 事实都尝试过；第一条写库失败不索引（无库记录的向量是幽灵），第二条成功+索引
    expect(calls).toBe(2);
    expect(indexMemory).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining("flush 落库失败"),
    );
    // 主流程完成：归档 + 落档都在
    expect(await repo.listBySession("s1")).toEqual([]);
    expect((await fs.readdir(compressedDir("a1"))).filter((f) => f.endsWith(".md"))).toHaveLength(1);
  });

  it("索引失败仅 warn 跳过：库记录保留，主流程不炸", async () => {
    const ids = ["m1", "m2", "m3", "m4"];
    const repo = new MessageRepository("a1");
    for (const id of ids) await repo.append(makeMsg(id));
    const { deps, indexMemory } = makeDeps(repo, REPLY_WITH_FACTS);
    indexMemory.mockRejectedValue(new Error("sidecar down"));
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    await runCompressionTask(makeSegment(ids), deps);

    expect(await new MemoryRepository("a1").list()).toHaveLength(2);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining("flush 向量索引失败"),
    );
    expect(await repo.listBySession("s1")).toEqual([]);
  });

  it("R1 去重：第二次 flush 同 facts（M13 重试/重复压缩）不重复落盘不重复索引", async () => {
    const ids = ["m1", "m2", "m3", "m4"];
    const repo = new MessageRepository("a1");
    for (const id of ids) await repo.append(makeMsg(id));
    const { deps, indexMemory } = makeDeps(repo, REPLY_WITH_FACTS);

    await runCompressionTask(makeSegment(ids), deps);
    expect(await new MemoryRepository("a1").list()).toHaveLength(2);
    expect(indexMemory).toHaveBeenCalledTimes(2);

    // 模拟 M13 队列重试：整段重跑（archiveAndRemove 第二次静默 no-op），facts 相同
    await runCompressionTask(makeSegment(ids), deps);

    // 文本逐字重复 → 写库与索引都跳
    expect(await new MemoryRepository("a1").list()).toHaveLength(2);
    expect(indexMemory).toHaveBeenCalledTimes(2);
  });

  it("R1 去重：库中已有同文本事实（含手录/他话题沉淀）时只落新事实", async () => {
    const ids = ["m1", "m2", "m3", "m4"];
    const repo = new MessageRepository("a1");
    for (const id of ids) await repo.append(makeMsg(id));
    // 预置一条与 flush 事实逐字相同的既有记忆
    await new MemoryRepository("a1").append({
      id: "mem_existing",
      content: "指挥官拍板用方案 C",
      embeddingId: "mem:mem_existing",
      createdAt: "2026-07-20T10:00:00.000Z",
    });
    const { deps, indexMemory } = makeDeps(repo, REPLY_WITH_FACTS);

    await runCompressionTask(makeSegment(ids), deps);

    const memories = await new MemoryRepository("a1").list();
    expect(memories).toHaveLength(2);
    expect(memories.map((m) => m.content).sort()).toEqual(["指挥官拍板用方案 C", "部署窗口在周五晚上"]);
    // 只有新事实进索引
    expect(indexMemory).toHaveBeenCalledTimes(1);
    expect(indexMemory.mock.calls[0]![1]).toBe("部署窗口在周五晚上");
  });

  it("摘要命中注入检测降级仅归档：不 flush（摘要可疑则同次事实同样可疑）", async () => {
    const ids = ["m1", "m2", "m3", "m4"];
    const repo = new MessageRepository("a1");
    for (const id of ids) await repo.append(makeMsg(id));
    const { deps, indexMemory } = makeDeps(repo, REPLY_WITH_FACTS);
    deps.mind = {
      appendMindExperiences: async () => ({ appended: 0, merged: 0, skipped: 0 }),
      isInjectionSuspect: () => true,
    };
    vi.spyOn(logger, "warn").mockImplementation(() => {});

    await runCompressionTask(makeSegment(ids), deps);

    expect(indexMemory).not.toHaveBeenCalled();
    expect(await new MemoryRepository("a1").list()).toEqual([]);
    // 降级路径语义不变：消息归档离开热存储、无压缩档
    expect(await repo.listBySession("s1")).toEqual([]);
    expect(await fs.readdir(compressedDir("a1")).catch(() => [])).toEqual([]);
  });
});
