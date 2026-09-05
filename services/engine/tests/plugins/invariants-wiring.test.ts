import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Context } from "cordis";
import { z } from "zod";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentWorker } from "../../src/core/agent-worker.js";
import type {
  Job,
  LLMRequestEvent,
  TurnStepEvent,
  TurnEndEvent,
  ToolApprovalEvent,
} from "../../src/core/agent-worker.js";
import { mindService } from "../../src/plugins/mind/index.js";
import { computeService } from "../../src/plugins/compute/index.js";
import { MessageRepository } from "../../src/memory/repositories/message.js";
import { runCompressionTask } from "../../src/memory/topic/compression-task.js";
import type { TopicSegment } from "../../src/memory/topic/types.js";
import type { AgentConfig, ChatMessage } from "@cloudmind/shared";
import type { ChatMessageRecord } from "../../src/memory/repositories/types.js";
import type { LLMEvent, LLMChatParams, LLMProvider } from "../../src/provider/types.js";
import type { Tool, ToolResult } from "../../src/tools/types.js";
import type { AgentsFace } from "../../src/plugins/agents/index.js";
import type { MemoryFace, MemoryArchivedEvent } from "../../src/plugins/memory/index.js";
import * as logPlugin from "../../src/plugins/log/index.js";
import * as configPlugin from "../../src/plugins/config/index.js";
import * as llmPlugin from "../../src/plugins/llm/index.js";
import * as toolsPlugin from "../../src/plugins/tools/index.js";
import * as skillsPlugin from "../../src/plugins/skills/index.js";
import * as memoryPlugin from "../../src/plugins/memory/index.js";
import * as mindPlugin from "../../src/plugins/mind/index.js";
import * as pipelinePlugin from "../../src/plugins/pipeline/index.js";
import * as computePlugin from "../../src/plugins/compute/index.js";
import * as agentsPlugin from "../../src/plugins/agents/index.js";
import * as perceptionPlugin from "../../src/plugins/perception/index.js";
import * as intermindPlugin from "../../src/plugins/intermind/index.js";
import * as subagentsPlugin from "../../src/plugins/subagents/index.js";
import * as invariantsPlugin from "../../src/plugins/invariants/index.js";
import { InvariantError } from "../../src/plugins/invariants/index.js";
import { restoreDataDir } from "../helpers/env.js";

// P8b 事件缝 wiring 测试：
// A. worker 直造 + 与 agents 插件同一接线式——载荷/顺序/引用一致性 + 违例注入
//    （真实接线由 B 覆盖，此处精确断言 worker 发射点语义）；
// B. 全插件链——agents 插件真实装配的 worker 发射 llm/request/turn/step/turn/end；
// C. memory/archived 缝——memory 插件 config 回调 + 压缩任务 onArchived。

class CapturingProvider implements LLMProvider {
  name = "capturing";
  capturedParams: LLMChatParams | undefined;
  private nextToolCalls: Array<{ toolCallId: string; name: string; arguments: unknown }> = [];

  supportsModel() {
    return true;
  }

  setNextToolCalls(toolCalls: Array<{ toolCallId: string; name: string; arguments: unknown }>): void {
    this.nextToolCalls = toolCalls;
  }

  async *chat(params: LLMChatParams): AsyncIterable<LLMEvent> {
    this.capturedParams = params;
    if (this.nextToolCalls.length > 0) {
      for (const tc of this.nextToolCalls) yield { type: "tool.call", ...tc };
      this.nextToolCalls = [];
    } else {
      yield { type: "text.delta", delta: "ok" };
    }
    yield { type: "step.end" };
  }
}

const dangerTool: Tool = {
  name: "danger",
  description: "需要审批的危险工具",
  parameters: z.object({}),
  accesses: [],
  requiresApproval: true,
  async execute(): Promise<ToolResult> {
    return { success: true, output: "done" };
  },
};

function userMessage(id: string, text = "你好"): ChatMessage {
  return { id, role: "user", content: [{ type: "text", text }], createdAt: "2026-08-17T00:00:00.000Z" };
}

function makeRec(id: string): ChatMessageRecord {
  return { ...userMessage(id), sessionId: "s1" };
}

describe("P8b 事件缝 wiring", () => {
  let tmpDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "invariants-wiring-test-"));
    originalDataDir = process.env.CLOUDMIND_DATA_DIR;
    process.env.CLOUDMIND_DATA_DIR = tmpDir;
  });

  afterEach(async () => {
    restoreDataDir(originalDataDir);
    await fs.rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /** 挂 invariants（enforce 缺省）；memory 面用真实 MessageRepository（read-back 走真实文件） */
  async function mountInvariants(existingAgents: string[] = ["agent-1"]): Promise<Context> {
    const ctx = new Context();
    ctx.provide("agents", {
      agentRepository: {
        get: async (id: string) => (existingAgents.includes(id) ? ({ id } as AgentConfig) : undefined),
      },
    } as unknown as AgentsFace);
    ctx.provide("memory", {
      getMessageRepository: (id: string) => new MessageRepository(id),
    } as unknown as MemoryFace);
    await ctx.plugin(invariantsPlugin);
    return ctx;
  }

  /** 与 agents 插件同一接线式的事件缝 config（真实接线由 Part B 覆盖） */
  function makeWorker(ctx: Context, provider: LLMProvider, tools: Tool[] = []): AgentWorker {
    return new AgentWorker({
      agentId: "agent-1",
      model: "mock",
      provider,
      tools,
      workspaceDir: tmpDir,
      messageRepository: new MessageRepository("agent-1"),
      approve: async () => true,
      mind: mindService,
      compute: computeService,
      emitTurnEvent: async (type, payload) => {
        if (type === "turn/step") await ctx.serial("turn/step", payload as TurnStepEvent);
        else if (type === "turn/end") await ctx.serial("turn/end", payload as TurnEndEvent);
        else await ctx.serial("tool/approval", payload as ToolApprovalEvent);
      },
      onLLMRequest: async (payload) => {
        await ctx.waterfall("llm/request", payload, () => payload);
      },
    });
  }

  function runJob(
    worker: AgentWorker,
    job: Pick<Job, "id" | "messages" | "sessionId"> & Partial<Job>,
  ): Promise<{ err?: unknown; frames: LLMEvent[] }> {
    const frames: LLMEvent[] = [];
    return new Promise((resolve) => {
      worker.enqueue({
        onEvent: (e) => frames.push(e),
        ...job,
        onDone: (err) => resolve({ err, frames }),
      });
    });
  }

  /** 事件捕获三件套（在 invariants 之后注册：prepend 保证断言仍为首棒） */
  function capture(ctx: Context) {
    const events: string[] = [];
    const requests: LLMRequestEvent[] = [];
    const steps: TurnStepEvent[] = [];
    const ends: TurnEndEvent[] = [];
    const approvals: ToolApprovalEvent[] = [];
    ctx.on("llm/request", (p, next) => {
      events.push("llm/request");
      requests.push(p);
      return next();
    });
    ctx.on("turn/step", (p) => {
      events.push("turn/step");
      steps.push(p);
    });
    ctx.on("turn/end", (p) => {
      events.push("turn/end");
      ends.push(p);
    });
    ctx.on("tool/approval", (p) => {
      events.push("tool/approval");
      approvals.push(p);
    });
    return { events, requests, steps, ends, approvals };
  }

  describe("A. worker 发射点（同一接线式）", () => {
    it("llm/request → turn/step → turn/end：载荷与顺序，payload.messages 即请求本体引用", async () => {
      const ctx = await mountInvariants();
      const { events, requests, steps, ends } = capture(ctx);
      const provider = new CapturingProvider();
      const worker = makeWorker(ctx, provider);
      const repo = new MessageRepository("agent-1");
      const input = userMessage("u-1");
      await repo.append({ ...input, sessionId: "s1" });

      const { err } = await runJob(worker, { id: "job-1", messages: [input], sessionId: "s1" });

      expect(err).toBeUndefined();
      expect(events).toEqual(["llm/request", "turn/step", "turn/end"]);
      expect(requests[0]).toMatchObject({ agentId: "agent-1", sessionId: "s1", model: "mock", source: "turn" });
      // 引用一致性：载荷 messages 就是 provider.chat 收到的同一数组
      expect(requests[0].messages).toBe(provider.capturedParams!.messages);
      expect(requests[0].messages[0]!.role).toBe("system");
      expect(steps[0]).toMatchObject({ agentId: "agent-1", sessionId: "s1" });
      expect(steps[0].messageIds).toHaveLength(1);
      // enforce 已 read-back 通过；显式再查证一次落盘内容
      const persisted = await repo.getByIds(steps[0].messageIds);
      expect(persisted.map((m) => m.id)).toEqual(steps[0].messageIds);
      expect(ends[0]).toMatchObject({
        agentId: "agent-1",
        sessionId: "s1",
        jobId: "job-1",
        inputMessageIds: ["u-1"],
        ephemeral: false,
      });
    });

    it("tool/approval：无审批通道拒危险工具——决策不变，事件载荷 approved=false（A4-5 通过）", async () => {
      const ctx = await mountInvariants();
      const { events, approvals } = capture(ctx);
      const provider = new CapturingProvider();
      provider.setNextToolCalls([{ toolCallId: "tc1", name: "danger", arguments: {} }]);
      const executeSpy = vi.spyOn(dangerTool, "execute");
      const worker = makeWorker(ctx, provider, [dangerTool]);
      const repo = new MessageRepository("agent-1");
      const input = userMessage("u-2");
      await repo.append({ ...input, sessionId: "s1" });

      const { err } = await runJob(worker, { id: "job-2", messages: [input], sessionId: "s1" });

      expect(err).toBeUndefined();
      expect(events).toEqual(["llm/request", "tool/approval", "turn/step", "llm/request", "turn/step", "turn/end"]);
      expect(approvals[0]).toEqual({
        agentId: "agent-1",
        toolName: "danger",
        requiresApproval: true,
        hasApprovalChannel: false,
        approved: false,
      });
      // fail-closed 未被事件缝改变：工具本体未执行
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it("违例注入（A4-2③）：输入未落盘的非瞬态回合，turn/end 断言 enforce 兑现为 job 失败（终帧不双发）", async () => {
      const ctx = await mountInvariants();
      capture(ctx);
      const provider = new CapturingProvider();
      const worker = makeWorker(ctx, provider);
      // 故意不落盘输入消息——破坏"先落盘后入队"
      const ghost = userMessage("u-ghost");

      const { err, frames } = await runJob(worker, { id: "job-v", messages: [ghost], sessionId: "s1" });

      expect(err).toBeInstanceOf(InvariantError);
      expect((err as InvariantError).invariant).toBe("A4-2");
      expect((err as InvariantError).message).toContain("先落盘后入队");
      // 视同该回合失败：onDone 收 InvariantError；成功路径 runTurn 已发一次
      // turn.end，断言否决不再补帧（P3-1「不存在双发」不变量保持）
      expect(frames.filter((f) => f.type === "turn.end")).toHaveLength(1);
    });

    it("违例注入（A4-2①）：agent 不存在，llm/request 在 provider.chat 前否决（chat 未被调用）", async () => {
      const ctx = await mountInvariants([]); // agent-1 不存在
      capture(ctx);
      const provider = new CapturingProvider();
      const worker = makeWorker(ctx, provider);
      const repo = new MessageRepository("agent-1");
      const input = userMessage("u-3");
      await repo.append({ ...input, sessionId: "s1" });

      const { err, frames } = await runJob(worker, { id: "job-v2", messages: [input], sessionId: "s1" });

      expect(err).toBeInstanceOf(InvariantError);
      expect((err as InvariantError).invariant).toBe("A4-2");
      expect((err as InvariantError).message).toContain("agent 不存在");
      // 否决语义：请求从未发出
      expect(provider.capturedParams).toBeUndefined();
      // 与现有 turn 失败路径一致：catch 补恰好一次终帧
      expect(frames.filter((f) => f.type === "turn.end")).toHaveLength(1);
    });
  });

  describe("B. agents 插件真实接线", () => {
    let originalNodeEnv: string | undefined;

    beforeEach(() => {
      originalNodeEnv = process.env.NODE_ENV;
    });

    afterEach(() => {
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
    });

    it("getOrCreateWorker 的 worker 发射 llm/request/turn/step/turn/end（全插件链）", async () => {
      const ctx = new Context();
      await ctx.plugin(logPlugin);
      await ctx.plugin(configPlugin);
      await ctx.plugin(llmPlugin);
      await ctx.plugin(toolsPlugin);
      // 与 bootstrap 同一接线式：memory/archived 通道经 config 回调进场
      await ctx.plugin(memoryPlugin, {
        onTopicArchived: (agentId, ids) => ctx.serial("memory/archived", { agentId, ids }),
      });
      await ctx.plugin(mindPlugin);
      await ctx.plugin(pipelinePlugin);
      await ctx.plugin(computePlugin);
      await ctx.plugin(skillsPlugin, {
        getAgentConfig: (agentId: string) => ctx.memory.agentRepository.get(agentId),
      });
      await ctx.plugin(agentsPlugin, {
        getSubagentServices: () => ({
          subagentDispatcher: {} as never,
          subagentSwarm: {} as never,
          puppetModelService: {} as never,
          intermindService: {} as never,
        }),
        getSidecar: () => ({} as never),
      });
      await ctx.plugin(invariantsPlugin);

      await ctx.memory.agentRepository.save("wire-agent", {
        id: "wire-agent",
        name: "wire",
        persona: "",
        model: "mock",
        skills: [],
        tools: [],
      });

      // e2e 环境 createProvider 走 MockLLMProvider（真实算力不进场）
      process.env.NODE_ENV = "e2e";
      const worker = await ctx.agents.getOrCreateWorker("wire-agent");
      expect(worker).toBeDefined();

      const { events, requests, steps, ends } = capture(ctx);
      const repo = new MessageRepository("wire-agent");
      const input = userMessage("w-1");
      await repo.append({ ...input, sessionId: "s-wire" });

      const frames: LLMEvent[] = [];
      const err = await new Promise<unknown>((resolve) => {
        worker!.enqueue({
          id: "job-wire",
          messages: [input],
          sessionId: "s-wire",
          onEvent: (e) => frames.push(e),
          onDone: resolve,
        });
      });

      expect(err).toBeUndefined();
      expect(events).toEqual(["llm/request", "turn/step", "turn/end"]);
      expect(requests[0]).toMatchObject({ agentId: "wire-agent", sessionId: "s-wire", source: "turn" });
      expect(requests[0].messages[0]!.role).toBe("system");
      expect(steps[0].messageIds).toHaveLength(1);
      expect(ends[0]).toMatchObject({
        agentId: "wire-agent",
        sessionId: "s-wire",
        jobId: "job-wire",
        inputMessageIds: ["w-1"],
        ephemeral: false,
      });
    });
  });

  describe("C. memory/archived 缝", () => {
    it("memory 插件：config 回调上架 onTopicArchived；缺省不上架（过渡形态零事件）", async () => {
      const seen: MemoryArchivedEvent[] = [];
      const ctx = new Context();
      ctx.on("memory/archived", (p) => {
        seen.push(p);
      });
      // P9：memory inject ["llm", "mind"]（启动对账依赖）——先备齐依赖再挂载
      await ctx.plugin(configPlugin);
      await ctx.plugin(llmPlugin);
      await ctx.plugin(mindPlugin);
      await ctx.plugin(memoryPlugin, {
        onTopicArchived: (agentId, ids) => ctx.serial("memory/archived", { agentId, ids }),
      });
      expect(typeof ctx.memory.onTopicArchived).toBe("function");
      await ctx.memory.onTopicArchived!("a1", ["m1"]);
      expect(seen).toEqual([{ agentId: "a1", ids: ["m1"] }]);

      const ctx2 = new Context();
      await ctx2.plugin(configPlugin);
      await ctx2.plugin(llmPlugin);
      await ctx2.plugin(mindPlugin);
      await ctx2.plugin(memoryPlugin);
      expect(ctx2.memory.onTopicArchived).toBeUndefined();
    });

    it("runCompressionTask：归档成功后调 onArchived（archiveOnly 路径），热存储清空归档全在", async () => {
      const repo = new MessageRepository("a1");
      const ids = ["m1", "m2"];
      for (const id of ids) await repo.append(makeRec(id));
      const onArchived = vi.fn();
      const segment: TopicSegment = {
        topicId: "tp_wire",
        messages: ids.map(makeRec),
        sourceId: "s1",
        startedAt: "2026-08-17T00:00:00.000Z",
        endedAt: "2026-08-17T00:05:00.000Z",
        archiveOnly: true,
      };

      await runCompressionTask(segment, {
        agentId: "a1",
        provider: new CapturingProvider(),
        model: "mock",
        messageRepository: repo,
        mind: mindService,
        onArchived,
      });

      expect(onArchived).toHaveBeenCalledWith(ids);
      expect(await repo.getByIds(ids)).toEqual([]);
      expect(await repo.getArchivedByIds(ids)).toHaveLength(2);
    });

    it("onArchived 抛错（invariants enforce）按压缩任务失败原样上传", async () => {
      const repo = new MessageRepository("a1");
      const ids = ["m3"];
      for (const id of ids) await repo.append(makeRec(id));
      const segment: TopicSegment = {
        topicId: "tp_wire2",
        messages: ids.map(makeRec),
        sourceId: "s1",
        startedAt: "2026-08-17T00:00:00.000Z",
        endedAt: "2026-08-17T00:05:00.000Z",
        archiveOnly: true,
      };

      await expect(
        runCompressionTask(segment, {
          agentId: "a1",
          provider: new CapturingProvider(),
          model: "mock",
          messageRepository: repo,
          mind: mindService,
          onArchived: () => {
            throw new InvariantError("A4-3", "注入违例");
          },
        }),
      ).rejects.toThrow(InvariantError);
    });
  });

  describe("D. subagent 前台路径（A4-2 缺口补齐：先落盘后入队）", () => {
    let originalNodeEnv: string | undefined;

    beforeEach(() => {
      originalNodeEnv = process.env.NODE_ENV;
    });

    afterEach(() => {
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
    });

    it("runAgentCollect：构造输入消息先落盘再入队，turn/end 的 A4-2③ 查证通过", async () => {
      const ctx = new Context();
      await ctx.plugin(logPlugin);
      await ctx.plugin(configPlugin);
      await ctx.plugin(llmPlugin);
      await ctx.plugin(toolsPlugin);
      await ctx.plugin(memoryPlugin);
      await ctx.plugin(mindPlugin);
      await ctx.plugin(pipelinePlugin);
      await ctx.plugin(computePlugin);
      await ctx.plugin(skillsPlugin, {
        getAgentConfig: (agentId: string) => ctx.memory.agentRepository.get(agentId),
      });
      await ctx.plugin(agentsPlugin, {
        getSubagentServices: () => ({
          subagentDispatcher: {} as never,
          subagentSwarm: {} as never,
          puppetModelService: {} as never,
          intermindService: {} as never,
        }),
        getSidecar: () => ({} as never),
      });
      await ctx.plugin(perceptionPlugin);
      await ctx.plugin(intermindPlugin);
      await ctx.plugin(subagentsPlugin);
      await ctx.plugin(invariantsPlugin);

      await ctx.memory.agentRepository.save("sub-agent", {
        id: "sub-agent",
        name: "sub",
        persona: "",
        model: "mock",
        skills: [],
        tools: [],
      });

      process.env.NODE_ENV = "e2e"; // createProvider → MockLLMProvider
      const ends: TurnEndEvent[] = [];
      ctx.on("turn/end", (p) => {
        ends.push(p);
      });

      const synthetic = userMessage("sub-u-1", "子任务：整理结论");
      // invariants enforce 挂载下跑通 = A4-2③ 未判违例
      const text = await ctx.subagents.runAgentCollect("sub-agent", [synthetic]);
      expect(text).toContain("Hello from mock");

      // 输入消息已先落盘（sessionId = subagent_<uuid> 独立命名空间）
      expect(ends).toHaveLength(1);
      expect(ends[0]!.inputMessageIds).toEqual(["sub-u-1"]);
      expect(ends[0]!.sessionId).toMatch(/^subagent_/);
      const repo = new MessageRepository("sub-agent");
      const found = await repo.getByIds(["sub-u-1"]);
      expect(found).toHaveLength(1);
      expect(found[0]!.sessionId).toBe(ends[0]!.sessionId);
    });
  });
});
