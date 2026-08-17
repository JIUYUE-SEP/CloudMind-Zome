import { describe, it, expect, vi, afterEach } from "vitest";
import { Context } from "cordis";
import { logger } from "../../src/logger.js";
import type { AgentConfig, ChatMessage } from "@mindcloud/shared";
import type { ChatMessageRecord } from "../../src/memory/repositories/types.js";
import type { AgentsFace } from "../../src/plugins/agents/index.js";
import type { MemoryFace } from "../../src/plugins/memory/index.js";
import type { LLMRequestEvent } from "../../src/core/agent-worker.js";
import * as invariantsPlugin from "../../src/plugins/invariants/index.js";
import { InvariantError } from "../../src/plugins/invariants/index.js";

// P8b invariants 插件单元测试：四条断言（A4-1/2/3/5）各覆盖「正常通过 +
// 注入违例 fail（enforce 抛 InvariantError）+ observe 记档不抛」三态。
// agents/memory 面用 mock（仓库语义压缩为内存数组），事件经 ctx.serial /
// ctx.waterfall 直发（与 agents 插件装配层同一派发式）。
describe("plugins/invariants（P8b）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function rec(id: string, sessionId = "s1"): ChatMessageRecord {
    return {
      id,
      sessionId,
      role: "user",
      content: [{ type: "text", text: `消息 ${id}` }],
      createdAt: "2026-08-17T00:00:00.000Z",
    };
  }

  function systemMsg(): ChatMessage {
    return { id: "sys", role: "system", content: [{ type: "text", text: "L1" }], createdAt: "2026-08-17" };
  }

  function userMsg(): ChatMessage {
    return { id: "u1", role: "user", content: [{ type: "text", text: "你好" }], createdAt: "2026-08-17" };
  }

  function llmReq(overrides: Partial<LLMRequestEvent> = {}): LLMRequestEvent {
    return {
      agentId: "a1",
      sessionId: "s1",
      model: "mock",
      messages: [systemMsg(), userMsg()],
      source: "turn",
      ...overrides,
    };
  }

  interface MountOpts {
    mode?: "enforce" | "observe";
    /** 存在的 agentId 清单（agentRepository.get mock） */
    agents?: string[];
    hot?: ChatMessageRecord[];
    archived?: ChatMessageRecord[];
    /** 缺省是否不传 config（验证缺省 = enforce） */
    omitConfig?: boolean;
  }

  async function mount(opts: MountOpts = {}) {
    const ctx = new Context();
    ctx.provide("agents", {
      agentRepository: {
        get: async (id: string) =>
          (opts.agents ?? []).includes(id) ? ({ id } as AgentConfig) : undefined,
      },
    } as unknown as AgentsFace);
    const repo = {
      getByIds: vi.fn(async (ids: string[]) => (opts.hot ?? []).filter((m) => ids.includes(m.id))),
      getArchivedByIds: vi.fn(async (ids: string[]) => (opts.archived ?? []).filter((m) => ids.includes(m.id))),
    };
    ctx.provide("memory", { getMessageRepository: () => repo } as unknown as MemoryFace);
    await ctx.plugin(
      invariantsPlugin,
      opts.omitConfig ? undefined : { mode: opts.mode ?? "enforce" },
    );
    return { ctx, repo };
  }

  it("插件元数据：name / inject / apply 四件套 + 上架面模式", async () => {
    expect(invariantsPlugin.name).toBe("invariants");
    expect(invariantsPlugin.inject).toEqual(["agents", "memory"]);
    expect(typeof invariantsPlugin.apply).toBe("function");
    const { ctx } = await mount({ omitConfig: true });
    // Config 缺省 = enforce
    expect(ctx.invariants.mode).toBe("enforce");
  });

  it("inject ['agents','memory'] 未就位时不激活（PENDING）", async () => {
    const ctx = new Context();
    const fiber = ctx.plugin(invariantsPlugin);
    // cordis rc.8：await fiber 对 PENDING 立即落定，激活与否看 fiber.state（PENDING=0）
    await fiber;
    expect(fiber.state).toBe(0);
    expect(ctx.get("invariants")).toBeUndefined();
  });

  describe("A4-2① llm/request（waterfall）", () => {
    // ctx.waterfall 静态返回类型是「同步值 | Promise」联合，统一经本 helper
    // await 收窄；inner = waterfall 末棒内建放行（cordis 以 (payload, next) 调它）
    async function fire(
      ctx: Context,
      payload: LLMRequestEvent,
      inner: () => LLMRequestEvent = () => payload,
    ): Promise<LLMRequestEvent> {
      return await ctx.waterfall("llm/request", payload, inner);
    }

    it("正常：agent 存在 + 首条 system，原样透传到 next", async () => {
      const { ctx } = await mount({ agents: ["a1"] });
      const payload = llmReq();
      const inner = vi.fn(() => payload);
      const result = await fire(ctx, payload, inner);
      expect(result).toBe(payload);
      expect(inner).toHaveBeenCalledOnce();
    });

    it("违例：agent 不存在，enforce 在 next 前抛 InvariantError", async () => {
      const { ctx } = await mount({ agents: [] });
      const inner = vi.fn(() => llmReq());
      const err = await fire(ctx, llmReq(), inner).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InvariantError);
      const ierr = err as InvariantError;
      expect(ierr.invariant).toBe("A4-2");
      expect(ierr.message).toContain("agent 不存在");
      // 否决语义：内建放行未被触达
      expect(inner).not.toHaveBeenCalled();
    });

    it("违例：agentId 为空 / messages 为空 / 首条非 system", async () => {
      const { ctx } = await mount({ agents: ["a1"] });
      const inner = vi.fn(() => llmReq());
      const err1 = await fire(ctx, llmReq({ agentId: "" }), inner).catch((e: unknown) => e);
      expect(err1).toBeInstanceOf(InvariantError);
      expect((err1 as InvariantError).message).toContain("缺 agentId");
      const err2 = await fire(ctx, llmReq({ messages: [] }), inner).catch((e: unknown) => e);
      expect(err2).toBeInstanceOf(InvariantError);
      expect((err2 as InvariantError).message).toContain("messages 为空");
      const err3 = await fire(ctx, llmReq({ messages: [userMsg()] }), inner).catch((e: unknown) => e);
      expect(err3).toBeInstanceOf(InvariantError);
      expect((err3 as InvariantError).message).toContain("L1");
      expect(inner).not.toHaveBeenCalled();
    });

    it("observe：记档不抛，请求照常放行到 next", async () => {
      const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
      const { ctx } = await mount({ mode: "observe", agents: [] });
      const payload = llmReq();
      const inner = vi.fn(() => payload);
      const result = await fire(ctx, payload, inner);
      expect(result).toBe(payload);
      expect(inner).toHaveBeenCalledOnce();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(InvariantError) }),
        expect.stringContaining("A4-2"),
      );
    });
  });

  describe("A4-1 同一 agentId 意识串行", () => {
    it("正常：同 session 多步 → turn/end → 同 session 新回合，不误伤", async () => {
      const { ctx } = await mount({ agents: ["a1"] });
      await ctx.serial("turn/step", { agentId: "a1", sessionId: "s1", messageIds: [] });
      await ctx.serial("turn/step", { agentId: "a1", sessionId: "s1", messageIds: [] });
      await ctx.serial("turn/end", {
        agentId: "a1",
        sessionId: "s1",
        jobId: "j1",
        inputMessageIds: [],
        ephemeral: false,
      });
      await ctx.serial("turn/step", { agentId: "a1", sessionId: "s1", messageIds: [] });
    });

    it("违例：前一回合（s1）未 turn/end，另一 session（s2）回合开始 → fail 含两 sessionId", async () => {
      const { ctx } = await mount({ agents: ["a1"] });
      await ctx.serial("turn/step", { agentId: "a1", sessionId: "s1", messageIds: [] });
      const err = await ctx
        .serial("turn/step", { agentId: "a1", sessionId: "s2", messageIds: [] })
        .catch((e) => e);
      expect(err).toBeInstanceOf(InvariantError);
      expect(err.invariant).toBe("A4-1");
      expect(err.message).toContain("s1");
      expect(err.message).toContain("s2");
    });

    it("observe：记档不抛", async () => {
      const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
      const { ctx } = await mount({ mode: "observe", agents: ["a1"] });
      await ctx.serial("turn/step", { agentId: "a1", sessionId: "s1", messageIds: [] });
      await ctx.serial("turn/step", { agentId: "a1", sessionId: "s2", messageIds: [] });
      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(InvariantError) }),
        expect.stringContaining("A4-1"),
      );
    });
  });

  describe("A4-2② turn/step 模型产出落盘 read-back", () => {
    it("正常：messageIds 全部读得回", async () => {
      const { ctx, repo } = await mount({ agents: ["a1"], hot: [rec("m1"), rec("m2")] });
      await ctx.serial("turn/step", { agentId: "a1", sessionId: "s1", messageIds: ["m1", "m2"] });
      expect(repo.getByIds).toHaveBeenCalledWith(["m1", "m2"]);
    });

    it("违例：任一一条读不回 → fail「模型产出未落盘」", async () => {
      const { ctx } = await mount({ agents: ["a1"], hot: [rec("m1")] });
      const err = await ctx
        .serial("turn/step", { agentId: "a1", sessionId: "s1", messageIds: ["m1", "m2"] })
        .catch((e) => e);
      expect(err).toBeInstanceOf(InvariantError);
      expect(err.invariant).toBe("A4-2");
      expect(err.message).toContain("模型产出未落盘");
      expect(err.context).toMatchObject({ missingCount: 1, missingIds: ["m2"] });
    });

    it("observe：记档不抛", async () => {
      const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
      const { ctx } = await mount({ mode: "observe", agents: ["a1"], hot: [] });
      await ctx.serial("turn/step", { agentId: "a1", sessionId: "s1", messageIds: ["m9"] });
      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(InvariantError) }),
        expect.stringContaining("模型产出未落盘"),
      );
    });
  });

  describe("A4-2③ turn/end 输入消息先落盘后入队", () => {
    it("正常：输入在热存储读得回", async () => {
      const { ctx } = await mount({ agents: ["a1"], hot: [rec("u1")] });
      await ctx.serial("turn/end", {
        agentId: "a1",
        sessionId: "s1",
        jobId: "j1",
        inputMessageIds: ["u1"],
        ephemeral: false,
      });
    });

    it("正常：热存储已移除但归档读得回（已随话题压缩归档）", async () => {
      const { ctx, repo } = await mount({ agents: ["a1"], hot: [], archived: [rec("u1")] });
      await ctx.serial("turn/end", {
        agentId: "a1",
        sessionId: "s1",
        jobId: "j1",
        inputMessageIds: ["u1"],
        ephemeral: false,
      });
      expect(repo.getArchivedByIds).toHaveBeenCalledWith(["u1"]);
    });

    it("违例：热存储与归档均读不回 → fail「先落盘后入队被破坏」", async () => {
      const { ctx } = await mount({ agents: ["a1"], hot: [], archived: [] });
      const err = await ctx
        .serial("turn/end", {
          agentId: "a1",
          sessionId: "s1",
          jobId: "j1",
          inputMessageIds: ["u1"],
          ephemeral: false,
        })
        .catch((e) => e);
      expect(err).toBeInstanceOf(InvariantError);
      expect(err.invariant).toBe("A4-2");
      expect(err.message).toContain("先落盘后入队");
    });

    it("ephemeral 豁免：瞬态回合设计不落盘，不做 read-back", async () => {
      const { ctx, repo } = await mount({ agents: ["a1"], hot: [], archived: [] });
      await ctx.serial("turn/end", {
        agentId: "a1",
        sessionId: "s1",
        jobId: "j1",
        inputMessageIds: ["u1"],
        ephemeral: true,
      });
      expect(repo.getByIds).not.toHaveBeenCalled();
      expect(repo.getArchivedByIds).not.toHaveBeenCalled();
    });

    it("observe：记档不抛", async () => {
      const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
      const { ctx } = await mount({ mode: "observe", agents: ["a1"], hot: [], archived: [] });
      await ctx.serial("turn/end", {
        agentId: "a1",
        sessionId: "s1",
        jobId: "j1",
        inputMessageIds: ["u1"],
        ephemeral: false,
      });
      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(InvariantError) }),
        expect.stringContaining("先落盘后入队"),
      );
    });
  });

  describe("A4-3 memory/archived 先归档后移除热存储", () => {
    it("正常：热存储已清空且归档全在", async () => {
      const { ctx } = await mount({ agents: ["a1"], hot: [], archived: [rec("m1"), rec("m2")] });
      await ctx.serial("memory/archived", { agentId: "a1", ids: ["m1", "m2"] });
    });

    it("违例：热存储仍残留 → fail", async () => {
      const { ctx } = await mount({ agents: ["a1"], hot: [rec("m2")], archived: [rec("m1"), rec("m2")] });
      const err = await ctx
        .serial("memory/archived", { agentId: "a1", ids: ["m1", "m2"] })
        .catch((e) => e);
      expect(err).toBeInstanceOf(InvariantError);
      expect(err.invariant).toBe("A4-3");
      expect(err.message).toContain("热存储仍残留");
    });

    it("违例：归档缺失 → fail", async () => {
      const { ctx } = await mount({ agents: ["a1"], hot: [], archived: [rec("m1")] });
      const err = await ctx
        .serial("memory/archived", { agentId: "a1", ids: ["m1", "m2"] })
        .catch((e) => e);
      expect(err).toBeInstanceOf(InvariantError);
      expect(err.invariant).toBe("A4-3");
      expect(err.message).toContain("归档缺失");
    });

    it("observe：记档不抛", async () => {
      const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
      const { ctx } = await mount({ mode: "observe", agents: ["a1"], hot: [rec("m1")], archived: [] });
      await ctx.serial("memory/archived", { agentId: "a1", ids: ["m1"] });
      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(InvariantError) }),
        expect.stringContaining("A4-3"),
      );
    });
  });

  describe("A4-5 tool/approval 审批 fail-closed", () => {
    const base = { agentId: "a1", toolName: "danger" };

    it("正常：有通道批准 / 无通道拒绝 / 非危险工具放行，均不违例", async () => {
      const { ctx } = await mount({ agents: ["a1"] });
      await ctx.serial("tool/approval", { ...base, requiresApproval: true, hasApprovalChannel: true, approved: true });
      await ctx.serial("tool/approval", { ...base, requiresApproval: true, hasApprovalChannel: false, approved: false });
      await ctx.serial("tool/approval", { ...base, requiresApproval: false, hasApprovalChannel: false, approved: true });
    });

    it("违例：无审批通道却 approved=true → fail「fail-closed 被突破」", async () => {
      const { ctx } = await mount({ agents: ["a1"] });
      const err = await ctx
        .serial("tool/approval", { ...base, requiresApproval: true, hasApprovalChannel: false, approved: true })
        .catch((e) => e);
      expect(err).toBeInstanceOf(InvariantError);
      expect(err.invariant).toBe("A4-5");
      expect(err.message).toContain("danger");
    });

    it("observe：记档不抛", async () => {
      const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
      const { ctx } = await mount({ mode: "observe", agents: ["a1"] });
      await ctx.serial("tool/approval", { ...base, requiresApproval: true, hasApprovalChannel: false, approved: true });
      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(InvariantError) }),
        expect.stringContaining("A4-5"),
      );
    });
  });
});
