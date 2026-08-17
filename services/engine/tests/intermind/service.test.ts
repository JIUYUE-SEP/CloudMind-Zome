import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentRepository } from "../../src/memory/repositories/agent.js";
import { MessageRepository } from "../../src/memory/repositories/message.js";
import {
  IntermindService,
  buildPrivateMessageNotice,
} from "../../src/intermind/service.js";
import { readPrivateMessagesTool } from "../../src/tools/builtin/read_private_messages.js";
import { mindService } from "../../src/plugins/mind/index.js";
import { computeService } from "../../src/plugins/compute/index.js";
import { logger } from "../../src/logger.js";
import { restoreDataDir } from "../helpers/env.js";
import { intermindSessionId, type ChatMessageRecord } from "@mindcloud/shared";
import type { AgentWorker } from "../../src/core/agent-worker.js";
import { AgentWorker as RealAgentWorker } from "../../src/core/agent-worker.js";
import type { IMessageRepository } from "../../src/memory/repositories/types.js";
import type { ToolContext } from "../../src/tools/types.js";
import { MockLLMProvider } from "../../src/provider/llm.js";

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
    getMessageRepository: (id) => new MessageRepository(id),
    // P8a：唤醒改经 perception 单口；harness 直连 worker 通道并回报已入队，
    // 白名单/无 worker 语义由 tests/plugins/perception.test.ts 覆盖
    injectNotice: async (p) => {
      worker.enqueueSystemNotice(p.text, p.sourceId, p.opts);
      return true;
    },
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
    expect(text).toBe(
      "【来自 甲 的私信】你好，乙——可用 send_private_message 给 ta 回信（to: a1）",
    );
    // 通知注入接收方主会话（与前端私聊同一会话），裸原文不写主会话（#8）
    expect(sourceId).toBe("default");
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

  it("搭车（wake=false）：不唤醒，但同一格式通知落接收方主会话（#9）", async () => {
    const result = await service.send("a2", "a1", "回信", { wake: false });
    expect(result.woke).toBe(false);
    expect(wakeSpy).not.toHaveBeenCalled();

    // 接收方 a1 主会话：一条格式化通知（前缀 + 回信指引 + senderId），不是裸原文
    const main = await new MessageRepository("a1").listBySession("default");
    expect(main).toHaveLength(1);
    expect(main[0]!.role).toBe("user");
    // M40：通知带发送方 agentId 归因（role 保持 user，协议/前端零影响）
    expect(main[0]!.agentId).toBe("a2");
    expect(textOf(main[0]!)).toBe(
      "【来自 乙 的私信】回信——可用 send_private_message 给 ta 回信（to: a2）",
    );
    expect(textOf(main[0]!)).not.toBe("回信");

    // intermind 来往线程：裸原文照常落盘（不带前缀）
    const received = await new MessageRepository("a1").listBySession("intermind:a2");
    expect(received).toHaveLength(1);
    expect(textOf(received[0]!)).toBe("回信");
    expect(textOf(received[0]!)).not.toContain("【来自");
  });

  it("唤醒与搭车两条路径的消息格式一致（仅唤醒行为不同，#9）", async () => {
    const content = "同一封信的内容";
    // 唤醒路径：通知经 enqueueSystemNotice 注入主会话 + 触发感知回合
    const woke = await service.send("a1", "a2", content);
    expect(woke.woke).toBe(true);
    expect(wakeSpy).toHaveBeenCalledTimes(1);
    const [wakeText, sourceId, opts] = wakeSpy.mock.calls[0] as [
      string,
      string,
      { intermindRide?: boolean },
    ];
    expect(sourceId).toBe("default");
    expect(opts.intermindRide).toBe(true);
    expect(wakeText).toBe(buildPrivateMessageNotice("甲", "a1", content));

    // 搭车路径：同一格式通知直接落接收方主会话，不再入队感知回合
    const ride = await service.send("a2", "a1", content, { wake: false });
    expect(ride.woke).toBe(false);
    expect(wakeSpy).toHaveBeenCalledTimes(1); // 搭车不触发第二次唤醒
    const rideMain = await new MessageRepository("a1").listBySession("default");
    expect(rideMain).toHaveLength(1);
    const rideText = textOf(rideMain[0]!);
    expect(rideText).toBe(buildPrivateMessageNotice("乙", "a2", content));

    // 两条路径同一格式：前缀 + 全文摘要 + 回信指引（senderId 各自归属）
    for (const text of [wakeText, rideText]) {
      expect(text).toContain("【来自");
      expect(text).toContain(content);
      expect(text).toContain("send_private_message");
      expect(text).toContain("——可用 send_private_message 给 ta 回信（to: ");
    }
  });

  it("搭车通知角色语义（M40）：role 保持 user，agentId 归因与用户亲口消息可区分", async () => {
    const repo = new MessageRepository("a1");
    // 用户亲口消息（ws 私聊路径落盘形态：role user、无 agentId）
    await repo.append({
      id: "m-user",
      sessionId: "default",
      role: "user",
      content: [{ type: "text", text: "用户亲口" }],
      createdAt: new Date().toISOString(),
    });
    await service.send("a2", "a1", "回信内容", { wake: false });

    const main = await repo.listBySession("default");
    expect(main).toHaveLength(2);
    const notice = main.find((m) => m.id !== "m-user")!;
    // role 保持 user：系统通知同范式——chat_completions 协议对中段 system 原样透传，
    // 改 system 会把对端来信摘要抬权为 system 指令（兼容性风险），故不动 role
    expect(notice.role).toBe("user");
    // 数据面归因：通知带发送方 agentId，用户亲口消息不带——REST/前端/审计可区分
    expect(notice.agentId).toBe("a2");
    expect(main.find((m) => m.id === "m-user")!.agentId).toBeUndefined();
    // 通知文本格式不破坏（#9 前缀 + 回信指引 + senderId）
    expect(textOf(notice)).toBe(
      "【来自 乙 的私信】回信内容——可用 send_private_message 给 ta 回信（to: a2）",
    );
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

  it("双写中途失败：接收方已落盘、发送方留底失败——报错 + 分叉审计留痕", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const failingSender: IMessageRepository = {
      append: async () => {
        throw new Error("disk full");
      },
      listBySession: async () => [],
      listBySessionWithArchived: async () => [],
      listBySessionPrefix: async () => [],
      getByIds: async () => [],
      archiveAndRemove: async () => {},
      getArchivedByIds: async () => [],
      listArchivedLazy: async function* () {},
    };
    const broken = new IntermindService({
      getAgentConfig: (id) => agentRepository.get(id),
      getMessageRepository: (id) =>
        id === "a1" ? failingSender : new MessageRepository(id),
      injectNotice: async () => true,
    });

    await expect(broken.send("a1", "a2", "hi")).rejects.toThrow("disk full");
    // 分叉状态有账可查：接收方有信、发送方无留底，且落分叉审计
    expect(await new MessageRepository("a2").listBySession("intermind:a1")).toHaveLength(1);
    expect(await new MessageRepository("a1").listBySession("intermind:a2")).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        fromAgentId: "a1",
        toAgentId: "a2",
        sessionId: "intermind:a1",
        persistedSide: "recipient",
      }),
      "[intermind] 私信双写分叉（部分落盘）",
    );
    warn.mockRestore();
  });

  it("接收方无可用 worker：信照常落盘，唤醒跳过并 warn（perception 侧承担，woke=false）", async () => {
    // P8a 起 service 不再解析 worker：「私信已落盘，接收方无可用 worker，唤醒跳过」
    // 的 warn 由 perception 侧承担并返回 false（见 tests/plugins/perception.test.ts）；
    // 本用例以 injectNotice 返回 false 模拟，恢复 woke=false 原语义断言
    const injectNotice = vi.fn(async () => false);
    const workerless = new IntermindService({
      getAgentConfig: (id) => agentRepository.get(id),
      getMessageRepository: (id) => new MessageRepository(id),
      injectNotice,
    });

    const result = await workerless.send("a1", "a2", "hi");
    expect(result.woke).toBe(false);
    expect(await new MessageRepository("a2").listBySession("intermind:a1")).toHaveLength(1);
    // 唤醒请求仍经单口委托（source 归属 + 主会话 sourceId + ride 标记）
    expect(injectNotice).toHaveBeenCalledWith({
      source: "intermind",
      targetAgentId: "a2",
      text: buildPrivateMessageNotice("甲", "a1", "hi"),
      sourceId: "default",
      opts: { intermindRide: true },
    });
  });

  it("收信后主会话只增一条通知消息：裸原文不进主会话，只在 intermind 线程（#8）", async () => {
    const recipientRepo = new MessageRepository("a2");
    const worker = new RealAgentWorker({
      mind: mindService,
      compute: computeService,
      agentId: "a2",
      model: "mock",
      provider: new MockLLMProvider(),
      tools: [],
      workspaceDir: "/tmp",
      messageRepository: recipientRepo,
      approve: async () => true,
    });
    const withRealWorker = new IntermindService({
      getAgentConfig: (id) => agentRepository.get(id),
      getMessageRepository: (id) => new MessageRepository(id),
      injectNotice: async (p) => {
        worker.enqueueSystemNotice(p.text, p.sourceId, p.opts);
        return true;
      },
    });

    await withRealWorker.send("a1", "a2", "你好，乙");
    // 等感知回合跑完：通知落盘 + 回合产出都稳定后再断言
    await vi.waitFor(() => expect(worker.status).toBe("idle"));

    // 主会话：user 角色只有一条通知（带回信指引与 senderId），绝无裸原文
    const main = await recipientRepo.listBySession("default");
    const mainUser = main.filter((m) => m.role === "user");
    expect(mainUser).toHaveLength(1);
    expect(mainUser[0]!.content[0]!.type).toBe("text");
    expect(textOf(mainUser[0]!)).toContain("【来自 甲 的私信】");
    expect(textOf(mainUser[0]!)).toContain("send_private_message");
    expect(textOf(mainUser[0]!)).toContain("to: a1");
    expect(textOf(mainUser[0]!)).not.toBe("你好，乙");

    // intermind 来信线程：裸原文恰好一条（不带前缀）
    const thread = await recipientRepo.listBySession("intermind:a1");
    expect(thread).toHaveLength(1);
    expect(textOf(thread[0]!)).toBe("你好，乙");
    expect(textOf(thread[0]!)).not.toContain("【来自");
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

  it("listSessions 与 messages 同口径：非 agent 列表的对端（历史/已删除）也列出", async () => {
    await new MessageRepository("a2").append({
      id: "m-ghost",
      sessionId: "intermind:ghost",
      role: "user",
      content: [{ type: "text", text: "旧信" }],
      agentId: "ghost",
      createdAt: new Date().toISOString(),
    });

    const sessions = await service.listSessions("a2");
    expect(sessions.map((s) => s.peer)).toContain("ghost");
    const msgs = await service.listMessages("a2", "ghost");
    expect(msgs).toHaveLength(1);
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

  it("通知文本：内容摘要截 200 字 + 回信指引带 senderId（#7）+ 截断时补读全文指引（P2-4）", () => {
    const notice = buildPrivateMessageNotice("甲", "a1", "x".repeat(250));
    expect(notice.startsWith("【来自 甲 的私信】")).toBe(true);
    expect(notice).toContain("send_private_message");
    expect(notice).toContain("to: a1");
    expect(notice).toContain("x".repeat(200) + "…");
    expect(notice).toContain(
      "……（信太长只显示了摘要，可用 read_private_messages 读全文，from: a1）",
    );
    expect(notice.endsWith("——可用 send_private_message 给 ta 回信（to: a1）")).toBe(true);
    expect(intermindSessionId("a2")).toBe("intermind:a2");
  });

  it("通知文本：未截断时不追加读全文指引（短信不啰嗦）", () => {
    const notice = buildPrivateMessageNotice("甲", "a1", "短信");
    expect(notice).not.toContain("read_private_messages");
    expect(notice).toBe(
      "【来自 甲 的私信】短信——可用 send_private_message 给 ta 回信（to: a1）",
    );
  });

  it("read_private_messages：写入若干长信后返回完整内容与方向；无会话返回空", async () => {
    const longContent = `开头${"长".repeat(250)}结尾`;
    await service.send("a1", "a2", longContent, { wake: false });
    await service.send("a2", "a1", "回信", { wake: false });

    const ctx: ToolContext = {
      agentId: "a2",
      workspaceDir: "/tmp",
      approve: async () => true,
      services: { intermindService: service },
    };
    const result = await readPrivateMessagesTool.execute(ctx, { from: "a1" });
    expect(result.success).toBe(true);
    const output = result.output as {
      count: number;
      messages: Array<{ direction: string; from: string; text: string }>;
    };
    expect(output.count).toBe(2);
    expect(output.messages[0]).toMatchObject({
      direction: "received",
      from: "a1",
      text: longContent,
    });
    expect(output.messages[1]).toMatchObject({ direction: "sent", from: "a2", text: "回信" });

    // 对端无会话：空列表不报错
    const empty = await readPrivateMessagesTool.execute(ctx, { from: "ghost" });
    expect(empty.success).toBe(true);
    expect((empty.output as { count: number }).count).toBe(0);
  });

  it("read_private_messages before 翻页跨热存储+归档（M36）：归档侧历史完整可翻", async () => {
    const repo = new MessageRepository("a2");
    // 4 封来信落热存储后，最旧 2 封归档（模拟 H8 溢出后的存储形态）
    for (let i = 1; i <= 4; i++) {
      await repo.append({
        id: `m-${i}`,
        sessionId: "intermind:a1",
        role: "user",
        content: [{ type: "text", text: `第${i}封` }],
        agentId: "a1",
        createdAt: `2026-08-01T00:00:0${i}.000Z`,
      });
    }
    await repo.archiveAndRemove(["m-1", "m-2"]);

    const ctx: ToolContext = {
      agentId: "a2",
      workspaceDir: "/tmp",
      approve: async () => true,
      services: { intermindService: service },
    };
    // 第一页：limit=3 → 跨存储归并后最近 3 封；满页 hint 的游标指向本页最旧一封（m-2，热存储头部）
    const page1 = await readPrivateMessagesTool.execute(ctx, { from: "a1", limit: 3 });
    expect(page1.success).toBe(true);
    const out1 = page1.output as {
      count: number;
      hint: string;
      messages: Array<{ id: string; text: string }>;
    };
    expect(out1.messages.map((m) => m.text)).toEqual(["第2封", "第3封", "第4封"]);
    expect(out1.hint).toContain('before: "m-2"');

    // 第二页：before=m-2 → 只剩归档侧的第1封（游标本身已归档不误拒，跨存储翻页成立）
    const page2 = await readPrivateMessagesTool.execute(ctx, { from: "a1", limit: 3, before: "m-2" });
    expect(page2.success).toBe(true);
    const out2 = page2.output as { hint: string; messages: Array<{ text: string }> };
    expect(out2.messages.map((m) => m.text)).toEqual(["第1封"]);
    expect(out2.hint).toContain("已读到最早");
  });

  it("before 未知游标：明确抛错（REST 映射 400）", async () => {
    await service.send("a1", "a2", "hi", { wake: false });
    await expect(
      service.listMessages("a2", "a1", { before: "no-such-id" }),
    ).rejects.toThrow("Invalid before cursor: no-such-id");
  });
});
