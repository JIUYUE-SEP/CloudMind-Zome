import { logger } from "../../src/logger.js";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LLMProvider, LLMEvent } from "../../src/provider/types.js";
import { MessageRepository } from "../../src/memory/repositories/message.js";
import type { ChatMessageRecord } from "../../src/memory/repositories/types.js";
import { runCompressionTask, type CompressionTaskDeps } from "../../src/memory/topic/compression-task.js";
import { compressedDir } from "../../src/memory/topic/store.js";
import type { TopicSegment } from "../../src/memory/topic/types.js";
import { restoreDataDir } from "../helpers/env.js";

// M12：经验沉淀必须在归档成功之后——先沉淀再归档时，归档失败的回滚只隔离
// 压缩档，MIND.md 留孤儿经验，重启对账重压缩会重复沉淀。
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
    topicId: "tp_m12_order",
    messages: ids.map(makeMsg),
    sourceId: "s1",
    startedAt: "2026-07-24T10:00:00.000Z",
    endedAt: "2026-07-24T10:05:00.000Z",
  };
}

// 压缩回复带一条经验（复核 prompt 同回复解析失败按单话题回退，属现状口径）
const REPLY_WITH_EXPERIENCE =
  "话题主题：部署\n关键结论：\n- 结论一\n经验：\n- 杀进程会连带 | 0.9 | 杀 node 进程会连带其他服务\n";

describe("runCompressionTask 经验沉淀时序（M12）", () => {
  let tmpDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "compression-order-test-"));
    originalDataDir = process.env.CLOUDMIND_DATA_DIR;
    process.env.CLOUDMIND_DATA_DIR = tmpDir;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
    restoreDataDir(originalDataDir);
  });

  function makeDeps(repo: MessageRepository): {
    deps: CompressionTaskDeps;
    appendExperiences: ReturnType<typeof vi.fn>;
  } {
    const appendExperiences = vi.fn(async () => ({ appended: 1, merged: 0, skipped: 0 }));
    return {
      deps: {
        agentId: "a1",
        provider: new FixedReplyProvider(REPLY_WITH_EXPERIENCE),
        model: "mock",
        messageRepository: repo,
        mind: {
          appendMindExperiences: appendExperiences,
          isInjectionSuspect: () => false,
        },
      },
      appendExperiences,
    };
  }

  it("归档成功后才沉淀：archiveAndRemove 先于 appendMindExperiences", async () => {
    const ids = ["m1", "m2", "m3", "m4"];
    const repo = new MessageRepository("a1");
    for (const id of ids) await repo.append(makeMsg(id));
    const { deps, appendExperiences } = makeDeps(repo);
    const order: string[] = [];
    const origArchive = repo.archiveAndRemove.bind(repo);
    vi.spyOn(repo, "archiveAndRemove").mockImplementation(async (msgIds: string[]) => {
      order.push("archive");
      return origArchive(msgIds);
    });
    appendExperiences.mockImplementation(async () => {
      order.push("experiences");
      return { appended: 1, merged: 0, skipped: 0 };
    });

    await runCompressionTask(makeSegment(ids), deps);

    expect(order).toEqual(["archive", "experiences"]);
    expect(appendExperiences).toHaveBeenCalledTimes(1);
    // 沉淀条目带 source/created 装饰（同一次 LLM 压缩调用的产出不变）
    expect(appendExperiences.mock.calls[0]![1]).toEqual([
      expect.objectContaining({
        title: "杀进程会连带",
        confidence: 0.9,
        source: "topic-tp_m12_order",
      }),
    ]);
    // 主流程结果不变：落档 + 归档
    expect(await repo.listBySession("s1")).toEqual([]);
    const files = await fs.readdir(compressedDir("a1"));
    expect(files.filter((f) => f.endsWith(".md"))).toHaveLength(1);
  });

  it("归档失败：不沉淀（无孤儿经验）、压缩档被隔离、消息留在热存储", async () => {
    const ids = ["m1", "m2", "m3", "m4"];
    const repo = new MessageRepository("a1");
    for (const id of ids) await repo.append(makeMsg(id));
    const { deps, appendExperiences } = makeDeps(repo);
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    vi.spyOn(repo, "archiveAndRemove").mockRejectedValue(new Error("disk full"));

    await expect(runCompressionTask(makeSegment(ids), deps)).rejects.toThrow("disk full");

    expect(appendExperiences).not.toHaveBeenCalled();
    // 压缩档已隔离（回滚），消息留在热存储待对账/重试
    expect(await fs.readdir(compressedDir("a1")).catch(() => [])).toEqual([]);
    expect((await repo.listBySession("s1")).map((m) => m.id)).toEqual(ids);
  });

  it("沉淀失败仅 warn 跳过：归档结果不受影响（挪动后语义不变）", async () => {
    const ids = ["m1", "m2", "m3", "m4"];
    const repo = new MessageRepository("a1");
    for (const id of ids) await repo.append(makeMsg(id));
    const { deps, appendExperiences } = makeDeps(repo);
    appendExperiences.mockRejectedValue(new Error("mind io"));
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    await runCompressionTask(makeSegment(ids), deps);

    expect(await repo.listBySession("s1")).toEqual([]);
    const files = await fs.readdir(compressedDir("a1"));
    expect(files.filter((f) => f.endsWith(".md"))).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining("经验沉淀失败"),
    );
  });
});
