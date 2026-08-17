import { describe, it, expect, vi } from "vitest";
import { Context } from "cordis";
import { logger } from "../../src/logger.js";
import type { AgentWorker } from "../../src/core/agent-worker.js";
import type { AgentsFace } from "../../src/plugins/agents/index.js";
import * as perceptionPlugin from "../../src/plugins/perception/index.js";
import { PERCEPTION_SOURCES } from "../../src/plugins/perception/index.js";

// P8a perception 插件测试：感知注入单口（决策 3）——白名单校验、waterfall
// 改写链、worker 解析与 enqueueSystemNotice 透传。agents 面用 mock
// （getOrCreateWorker + mock worker），不挂真 worker 创建链。
describe("plugins/perception（P8a）", () => {
  function makeWorker() {
    return { enqueueSystemNotice: vi.fn() } as unknown as AgentWorker;
  }

  function enqueueSpy(worker: AgentWorker): ReturnType<typeof vi.fn> {
    return worker.enqueueSystemNotice as ReturnType<typeof vi.fn>;
  }

  async function mountPerception(worker: AgentWorker | undefined) {
    const ctx = new Context();
    const getOrCreateWorker = vi.fn(async () => worker);
    ctx.provide("agents", { getOrCreateWorker } as unknown as AgentsFace);
    await ctx.plugin(perceptionPlugin);
    return { ctx, getOrCreateWorker };
  }

  it("插件元数据：name / inject ['agents'] / apply 四件套可读 + 白名单常量", () => {
    expect(perceptionPlugin.name).toBe("perception");
    expect(perceptionPlugin.inject).toEqual(["agents"]);
    expect(typeof perceptionPlugin.apply).toBe("function");
    expect(PERCEPTION_SOURCES).toEqual(["subagents", "intermind"]);
  });

  it("inject ['agents'] 未就位时不激活（PENDING）", async () => {
    const ctx = new Context();
    const fiber = ctx.plugin(perceptionPlugin);
    // cordis rc.8：await fiber 对 PENDING 立即落定，激活与否看 fiber.state（PENDING=0）
    await fiber;
    expect(fiber.state).toBe(0);
    expect(ctx.get("perception")).toBeUndefined();
  });

  it("白名单内 source：解析 worker，text/sourceId/opts 原样透传 enqueueSystemNotice", async () => {
    const worker = makeWorker();
    const { ctx, getOrCreateWorker } = await mountPerception(worker);

    const ok = await ctx.perception.injectNotice({
      source: "intermind",
      targetAgentId: "a2",
      text: "【来自 甲 的私信】你好",
      sourceId: "default",
      opts: { intermindRide: true },
    });

    // 已入队返回 true
    expect(ok).toBe(true);
    expect(getOrCreateWorker).toHaveBeenCalledWith("a2");
    expect(enqueueSpy(worker)).toHaveBeenCalledWith(
      "【来自 甲 的私信】你好",
      "default",
      { intermindRide: true },
    );
  });

  it("白名单外 source：warn 记档并丢弃（不解析 worker、不入队）", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const worker = makeWorker();
    const { ctx, getOrCreateWorker } = await mountPerception(worker);

    const ok = await ctx.perception.injectNotice({
      source: "rogue",
      targetAgentId: "a1",
      text: "x",
      sourceId: "s1",
    });

    // 丢弃返回 false
    expect(ok).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("白名单"));
    expect(getOrCreateWorker).not.toHaveBeenCalled();
    expect(enqueueSpy(worker)).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("目标无可用 worker：warn 并跳过（沿用原各生产者「无可用 worker」文案语义）", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const { ctx, getOrCreateWorker } = await mountPerception(undefined);

    const ok = await ctx.perception.injectNotice({
      source: "subagents",
      targetAgentId: "ghost",
      text: "[系统通知] …",
      sourceId: "notice_t1",
    });

    // 跳过返回 false
    expect(ok).toBe(false);
    expect(getOrCreateWorker).toHaveBeenCalledWith("ghost");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("无可用 worker"));
    warn.mockRestore();
  });

  it("perception/inject waterfall：中间件改写文本后 enqueue 收到改写值", async () => {
    const worker = makeWorker();
    const { ctx } = await mountPerception(worker);
    // 临时监听验证总线语义：先 next() 委托下游（内建放行 = 原样透传），再追加文本
    ctx.on("perception/inject", async (payload, next) => {
      const downstream = await next();
      return { ...downstream, text: `${downstream.text}（已改写）` };
    });

    await ctx.perception.injectNotice({
      source: "subagents",
      targetAgentId: "a1",
      text: "原文",
      sourceId: "notice_t2",
    });

    expect(enqueueSpy(worker)).toHaveBeenCalledWith("原文（已改写）", "notice_t2", undefined);
  });
});
