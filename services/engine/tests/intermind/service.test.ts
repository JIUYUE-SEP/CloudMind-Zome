import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentRepository } from "../../src/memory/repositories/agent.js";
import { MessageRepository } from "../../src/memory/repositories/message.js";
import {
  IntermindService,
  intermindSessionId,
  buildPrivateMessageNotice,
} from "../../src/intermind/service.js";
import { logger } from "../../src/logger.js";
import { restoreDataDir } from "../helpers/env.js";
import type { ChatMessageRecord } from "@mindcloud/shared";
import type { AgentWorker } from "../../src/core/agent-worker.js";

function textOf(record: ChatMessageRecord): string {
  const part = record.content[0]!;
  return part.type === "text" ? part.text : "";
}

let tmpDir: string;
let originalDataDir: string | undefined;
let agentRepository: AgentRepository;
let service: IntermindService;
let wakeSpy: ReturnType<typeof vi.fn>;

function makeWorker(): AgentWorker {
  return { enqueueSystemNotice: vi.fn() } as unknown as AgentWorker;
}

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "intermind-service-test-"));
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

  const worker = makeWorker();
  wakeSpy = worker.enqueueSystemNotice as ReturnType<typeof vi.fn>;
  service = new IntermindService({
    getAgentConfig: (id) => agentRepository.get(id),
    listAgents: () => agentRepository.list(),
    getMessageRepository: (id) => new MessageRepository(id),
    getAgentWorker: async () => worker,
  });
});

afterEach(async () => {
  restoreDataDir(originalDataDir);
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe("IntermindService.send", () => {
  it("写信：接收方与发送方 intermind 会话双写落盘 + 审计 + 唤醒感知回合（ride 标记）", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const result = await service.send("a1", "a2", "你好，乙");
    expect(result).toMatchObject({
      recipientSessionId: "intermind:a1",
      woke: true,
    });

    // 接收方 a2 的来信线程
    const received = await new MessageRepository("a2").listBySession("intermind:a1");
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      agentId: "a1",
      role: "user",
      content: [{ type: "text", text: "你好，乙" }],
    });
    // 发送方 a1 的来往线程留底
    const sent = await new MessageRepository("a1").listBySession("intermind:a2");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.agentId).toBe("a1");

    // 唤醒：一次 enqueueSystemNotice，文本格式 + 独立 notice 会话 + ride 标记
    expect(wakeSpy).toHaveBeenCalledTimes(1);
    const [text, sourceId, opts] = wakeSpy.mock.calls[0] as [string, string, { intermindRide?: boolean }];
    expect(text).toBe("【来自 甲 的私信】你好，乙");
    expect(sourceId.startsWith("notice_intermind:")).toBe(true);
    expect(opts.intermindRide).toBe(true);
    // 审计：谁给谁写了什么（warn 级，内容摘要）
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        fromAgentId: "a1",
        toAgentId: "a2",
        sessionId: "intermind:a1",
        content: "你好，乙",
      }),
      "[intermind] 私信",
    );
    warn.mockRestore();
  });

  it("搭车（wake=false）：只入队不唤醒", async () => {
    const result = await service.send("a2", "a1", "回信", { wake: false });
    expect(result.woke).toBe(false);
    expect(wakeSpy).not.toHaveBeenCalled();
    const received = await new MessageRepository("a1").listBySession("intermind:a2");
    expect(received).toHaveLength(1);
  });

  it("目标 agent 不存在：明确抛错，不写信不唤醒", async () => {
    await expect(service.send("a1", "ghost", "hi")).rejects.toThrow("Agent ghost not found");
    expect(wakeSpy).not.toHaveBeenCalled();
    expect(await new MessageRepository("ghost").listBySession("intermind:a1")).toEqual([]);
  });

  it("给自己写信：明确拒绝", async () => {
    await expect(service.send("a1", "a1", "hi")).rejects.toThrow("self-mail");
    expect(wakeSpy).not.toHaveBeenCalled();
  });

  it("接收方无可用 worker：信照常落盘，唤醒跳过并 warn", async () => {
    const workerless = new IntermindService({
      getAgentConfig: (id) => agentRepository.get(id),
      listAgents: () => agentRepository.list(),
      getMessageRepository: (id) => new MessageRepository(id),
      getAgentWorker: async () => undefined,
    });
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    const result = await workerless.send("a1", "a2", "hi");
    expect(result.woke).toBe(false);
    expect(await new MessageRepository("a2").listBySession("intermind:a1")).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("唤醒跳过"));
    warn.mockRestore();
  });
});

describe("IntermindService 会话检索", () => {
  it("listSessions：对端 + 最后消息时间 + 条数，按最后时间倒序", async () => {
    await service.send("a1", "a2", "第一条");
    await service.send("a1", "a2", "第二条", { wake: false });

    const sessions = await service.listSessions("a2");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.peer).toBe("a1");
    expect(sessions[0]!.count).toBe(2);
    expect(sessions[0]!.lastMessageAt).toBe(
      (await new MessageRepository("a2").listBySession("intermind:a1")).at(-1)!.createdAt,
    );
  });

  it("listMessages：分页读取来往消息（limit/before）", async () => {
    for (let i = 1; i <= 3; i++) {
      await service.send("a1", "a2", `第${i}条`, { wake: false });
    }
    const repo = new MessageRepository("a2");
    const all = await repo.listBySession("intermind:a1");
    expect(all.map((m) => textOf(m))).toEqual(["第1条", "第2条", "第3条"]);

    const limited = await service.listMessages("a2", "a1", { limit: 1 });
    expect(limited.map((m) => textOf(m))).toEqual(["第3条"]);

    const before = await service.listMessages("a2", "a1", { limit: 10, before: all[2]!.id });
    expect(before.map((m) => textOf(m))).toEqual(["第1条", "第2条"]);
  });

  it("通知文本：内容摘要截 200 字", () => {
    const notice = buildPrivateMessageNotice("甲", "x".repeat(250));
    expect(notice.startsWith("【来自 甲 的私信】")).toBe(true);
    expect(notice).toHaveLength("【来自 甲 的私信】".length + 200 + 1);
    expect(notice.endsWith("…")).toBe(true);
    expect(intermindSessionId("a2")).toBe("intermind:a2");
  });
});
