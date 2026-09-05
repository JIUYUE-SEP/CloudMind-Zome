import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentRepository } from "../../src/memory/repositories/agent.js";
import { MessageRepository } from "../../src/memory/repositories/message.js";
import { IntermindService, INTERMIND_HOT_LIMIT } from "../../src/intermind/service.js";
import { logger } from "../../src/logger.js";
import { restoreDataDir } from "../helpers/env.js";
import type { ChatMessageRecord } from "@cloudmind/shared";
import type { IMessageRepository } from "../../src/memory/repositories/types.js";

function textOf(record: ChatMessageRecord): string {
  const part = record.content[0]!;
  return part.type === "text" ? part.text : "";
}

let tmpDir: string;
let originalDataDir: string | undefined;
let agentRepository: AgentRepository;
let service: IntermindService;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "intermind-hot-limit-test-"));
  originalDataDir = process.env.CLOUDMIND_DATA_DIR;
  process.env.CLOUDMIND_DATA_DIR = tmpDir;

  agentRepository = new AgentRepository();
  await agentRepository.save("a1", {
    id: "a1",
    name: "甲",
    persona: "",
    skills: [],
    tools: [],
    model: "mock",
  });
  await agentRepository.save("a2", {
    id: "a2",
    name: "乙",
    persona: "",
    skills: [],
    tools: [],
    model: "mock",
  });

  service = new IntermindService({
    getAgentConfig: (id) => agentRepository.get(id),
    getMessageRepository: (id) => new MessageRepository(id),
    injectNotice: async () => true,
  });
});

afterEach(async () => {
  restoreDataDir(originalDataDir);
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe("Intermind 热存储封顶（H8）", () => {
  it("到顶不归档；第 上限+1 封后两侧热存储封顶、最旧溢出归档、跨存储读完整", async () => {
    const ids: string[] = [];
    for (let i = 1; i <= INTERMIND_HOT_LIMIT; i++) {
      const r = await service.send("a1", "a2", `第${i}条`, { wake: false });
      ids.push(r.messageId);
    }

    // 恰好到顶：两侧热存储各 上限 条，不触发归档
    const a2Repo = new MessageRepository("a2");
    const a1Repo = new MessageRepository("a1");
    const hotOpt = { limit: INTERMIND_HOT_LIMIT + 1 };
    expect(await a2Repo.listBySession("intermind:a1", hotOpt)).toHaveLength(INTERMIND_HOT_LIMIT);
    expect(await a1Repo.listBySession("intermind:a2", hotOpt)).toHaveLength(INTERMIND_HOT_LIMIT);
    expect(await a2Repo.getArchivedByIds(ids)).toEqual([]);

    // 第 上限+1 封：最旧的「第1条」在接收方来信线程与发送方来往线程两侧都溢出归档
    const overflow = await service.send("a1", "a2", `第${INTERMIND_HOT_LIMIT + 1}条`, { wake: false });
    ids.push(overflow.messageId);

    const hotA2 = await a2Repo.listBySession("intermind:a1", hotOpt);
    expect(hotA2).toHaveLength(INTERMIND_HOT_LIMIT);
    expect(hotA2.some((m) => m.id === ids[0])).toBe(false);
    expect(textOf(hotA2[0]!)).toBe("第2条");
    expect(textOf(hotA2.at(-1)!)).toBe(`第${INTERMIND_HOT_LIMIT + 1}条`);

    // 最旧消息出现在 messages_archived.jsonl（两侧对称）
    const archivedA2 = await a2Repo.getArchivedByIds([ids[0]!]);
    expect(archivedA2).toHaveLength(1);
    expect(textOf(archivedA2[0]!)).toBe("第1条");
    const archivedA1 = await a1Repo.getArchivedByIds([ids[0]!]);
    expect(archivedA1).toHaveLength(1);
    expect(await a1Repo.listBySession("intermind:a2", hotOpt)).toHaveLength(INTERMIND_HOT_LIMIT);

    // 跨存储读：完整 上限+1 条来往，时间序不变
    const all = await service.listMessages("a2", "a1", hotOpt);
    expect(all.map(textOf)).toEqual(
      Array.from({ length: INTERMIND_HOT_LIMIT + 1 }, (_, i) => `第${i + 1}条`),
    );

    // before 游标跨归档边界：第2条（热存储头部）之前只剩归档里的第1条
    const page = await service.listMessages("a2", "a1", { limit: 10, before: ids[1]! });
    expect(page.map(textOf)).toEqual(["第1条"]);
    // 游标本身已归档：不误拒（其前窗口为空）
    const empty = await service.listMessages("a2", "a1", { limit: 10, before: ids[0]! });
    expect(empty).toEqual([]);

    // listSessions 口径（G3c）：count 跨热存储+归档（热存储恒封顶 200，
    // 总数 上限+1）；lastMessageAt 取热存储最新一条
    const sessions = await service.listSessions("a2");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      peer: "a1",
      count: INTERMIND_HOT_LIMIT + 1,
      lastMessageAt: hotA2.at(-1)!.createdAt,
    });
  });

  it("并发 send 同刻修剪同一对 (repo, session)：串行修剪不产重复归档行（G3c）", async () => {
    // 直接预填接收方来信线程到恰好上限（避开 200 次 send 的慢路径）
    const a2Repo = new MessageRepository("a2");
    const base = Date.parse("2026-08-01T00:00:00.000Z");
    for (let i = 1; i <= INTERMIND_HOT_LIMIT; i++) {
      await a2Repo.append({
        id: `pre-${i}`,
        sessionId: "intermind:a1",
        role: "user",
        content: [{ type: "text", text: `预填${i}` }],
        agentId: "a1",
        createdAt: new Date(base + i * 1000).toISOString(),
      });
    }

    // 两封并发：各 append 一封后热存储最高 上限+2 条，两个修剪竞速同一批溢出。
    // 未串行化时两个修剪同读超帽快照、各自 append 同一批 id → 归档重复行
    await Promise.all([
      service.send("a1", "a2", "并发1", { wake: false }),
      service.send("a1", "a2", "并发2", { wake: false }),
    ]);

    // 串行修剪：前者归档最旧溢出、后者看到修剪后的真实水位自然跳过——
    // pre-1/pre-2 各恰好一行（getArchivedByIds 按文件行返回，重复行会暴露）
    const archived = await a2Repo.getArchivedByIds(["pre-1", "pre-2"]);
    expect(archived.map((m) => m.id).sort()).toEqual(["pre-1", "pre-2"]);
    expect(archived).toHaveLength(2);
    // 热存储收敛回上限，来往总数守恒（200 热 + 2 归档）
    const hot = await a2Repo.listBySession("intermind:a1", { limit: INTERMIND_HOT_LIMIT + 2 });
    expect(hot).toHaveLength(INTERMIND_HOT_LIMIT);
  });

  it("归档失败：写信本身成功、记 warn，热存储继续增长待下封重试", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    // 内存版 repository：archiveAndRemove 恒失败，模拟归档故障
    const messages: ChatMessageRecord[] = [];
    const failingArchive: IMessageRepository = {
      append: async (m) => {
        messages.push(m);
      },
      listBySession: async (sessionId, options) => {
        const filtered = messages.filter((m) => m.sessionId === sessionId);
        return filtered.slice(-(options?.limit ?? 100));
      },
      listBySessionWithArchived: async () => [],
      listBySessionPrefix: async () => [],
      getByIds: async () => [],
      archiveAndRemove: async () => {
        throw new Error("archive disk full");
      },
      getArchivedByIds: async () => [],
      listArchivedLazy: async function* () {},
    };
    const broken = new IntermindService({
      getAgentConfig: (id) => agentRepository.get(id),
      getMessageRepository: (id) => (id === "a2" ? failingArchive : new MessageRepository(id)),
      injectNotice: async () => true,
    });

    // 写信主流程不受归档故障影响：上限+1 封全部成功落盘
    for (let i = 1; i <= INTERMIND_HOT_LIMIT + 1; i++) {
      await expect(broken.send("a1", "a2", `第${i}条`, { wake: false })).resolves.toMatchObject({
        recipientSessionId: "intermind:a1",
      });
    }
    // 信照常写入（归档未成，热存储继续增长，留待下封重试）
    expect(messages.filter((m) => m.sessionId === "intermind:a1")).toHaveLength(
      INTERMIND_HOT_LIMIT + 1,
    );
    // 归档失败有 warn：仅超出上限的那封触发一次（到顶前不尝试归档）
    const archiveWarns = warn.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("热存储归档失败"),
    );
    expect(archiveWarns).toHaveLength(1);
    expect(archiveWarns[0]![0]).toContain("archive disk full");
    warn.mockRestore();
  });
});
