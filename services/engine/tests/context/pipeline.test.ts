import { logger } from "../../src/logger.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import type { ChatMessage } from "@cloudmind/shared";
import {
  ContextPipeline,
  DEFAULT_PIPELINE_CONFIG,
  type AssembleInput,
} from "../../src/context/pipeline.js";
import type { TopicSummary } from "../../src/context/layers.js";
import type { TokenCounter } from "../../src/context/token-counter.js";

function textOf(m: ChatMessage): string {
  return m.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}

function topicSummary(id: string, text: string): TopicSummary {
  // createdAt 早于 history(2026-07-17)：归并后摘要消息排在历史之前
  return { id, label: id, text, createdAt: "2026-07-10T00:00:00Z" };
}

/** 确定性假计数器：1 字符 = 1 "token"，便于精确控制预算 */
class FakeCounter implements TokenCounter {
  countText(text: string): number {
    return text.length;
  }
  countMessages(messages: ChatMessage[]): number {
    let total = 0;
    for (const m of messages) {
      total += 4;
      for (const c of m.content) total += c.type === "text" ? c.text.length : c.think.length;
      if (m.toolCalls) total += JSON.stringify(m.toolCalls).length;
    }
    return total;
  }
  countTools(tools: unknown[]): number {
    return JSON.stringify(tools).length;
  }
}

function history(n: number, text = "history"): ChatMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `h${i}`,
    role: "user" as const,
    content: [{ type: "text" as const, text: `${text} ${i}` }],
    createdAt: "2026-07-17T00:00:00Z",
  }));
}

function makeInput(overrides: Partial<AssembleInput> = {}): AssembleInput {
  return {
    agentId: "a1",
    history: [],
    mindContext: "",
    tools: [],
    sourceId: "s1",
    ...overrides,
  };
}

function makePipeline(maxContextTokens: number): ContextPipeline {
  return new ContextPipeline({ maxContextTokens, reserveRatio: 0 }, new FakeCounter());
}

describe("ContextPipeline", () => {
  it("默认配置：80000 tokens + 10% reserveRatio，预算 72000", () => {
    expect(DEFAULT_PIPELINE_CONFIG).toEqual({
      maxContextTokens: 80000,
      reserveRatio: 0.1,
    });
    const pipeline = new ContextPipeline({}, new FakeCounter());
    expect(pipeline.budgetTokens).toBe(72000);
  });

  it("H2：syncMaxContextTokens 热更窗口（同值幂等，不重建实例）", () => {
    const pipeline = makePipeline(80_000);
    expect(pipeline.budgetTokens).toBe(80_000);
    expect(pipeline.maxContextTokens).toBe(80_000);

    expect(pipeline.syncMaxContextTokens(32_000)).toBe(true);
    expect(pipeline.maxContextTokens).toBe(32_000);
    expect(pipeline.budgetTokens).toBe(32_000);

    // 同值幂等：返回 false，预算不再变化
    expect(pipeline.syncMaxContextTokens(32_000)).toBe(false);
    expect(pipeline.budgetTokens).toBe(32_000);
  });

  it("F3：syncMaxContextTokens 拒绝非正数/NaN/Infinity（预算不变，warn 留痕）", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const pipeline = makePipeline(80_000);
      for (const bad of [0, -1, NaN, Infinity, -Infinity]) {
        expect(pipeline.syncMaxContextTokens(bad)).toBe(false);
        expect(pipeline.maxContextTokens).toBe(80_000);
        expect(pipeline.budgetTokens).toBe(80_000);
      }
      expect(warn).toHaveBeenCalledTimes(5);
    } finally {
      warn.mockRestore();
    }
  });

  it("未超预算时原样组装：L1 system + 全部 history，tools 不变", async () => {
    const pipeline = makePipeline(10000);
    const tools = [{ type: "function", function: { name: "read_file" } }];
    const result = await pipeline.assemble(
      makeInput({ mindContext: "人格", history: history(3), tools }),
    );
    expect(result.messages[0].role).toBe("system");
    expect(result.messages.slice(1)).toHaveLength(3);
    expect(result.tools).toEqual(tools); // 内容一致（管线内部持有副本，不改调用方数组）
  });

  it("S6：组装时跳过历史中的旧水位提醒（role=system 且以 [系统提醒] 本轮上下文已用 开头）", async () => {
    const pipeline = makePipeline(10000);
    const staleReminder: ChatMessage = {
      id: "wm1",
      role: "system",
      content: [
        {
          type: "text",
          text:
            "[系统提醒] 本轮上下文已用约 85%（17000/20000 tokens）。" +
            "请收敛工具调用、优先收尾；如任务未完成，先总结当前进展与下一步计划。",
        },
      ],
      createdAt: "2026-07-17T00:00:00Z",
    };
    const result = await pipeline.assemble(
      makeInput({ history: [staleReminder, ...history(2)] }),
    );

    expect(result.messages.some((m) => m.id === "wm1")).toBe(false);
    expect(result.messages.map(textOf).some((t) => t.startsWith("[系统提醒] 本轮上下文已用"))).toBe(
      false,
    );
    // 其余历史照常组装
    expect(result.messages.filter((m) => m.role === "user")).toHaveLength(2);
  });

  it("S6：不误伤其他 system 消息（L1 人格/普通 system 历史仍组装）", async () => {
    const pipeline = makePipeline(10000);
    const normalSystem: ChatMessage = {
      id: "sys1",
      role: "system",
      content: [{ type: "text", text: "用户自定义规则：始终用中文回答" }],
      createdAt: "2026-07-17T00:00:00Z",
    };
    const otherSystemNotice: ChatMessage = {
      id: "sys2",
      role: "system",
      content: [{ type: "text", text: "[系统提醒] 其他系统通知（非水位）" }],
      createdAt: "2026-07-17T00:00:00Z",
    };
    const result = await pipeline.assemble(
      makeInput({
        mindContext: "人格",
        history: [normalSystem, otherSystemNotice, ...history(1)],
      }),
    );

    const systems = result.messages.filter((m) => m.role === "system").map(textOf);
    expect(systems).toContain("人格");
    expect(systems).toContain("用户自定义规则：始终用中文回答");
    expect(systems).toContain("[系统提醒] 其他系统通知（非水位）");
  });

  it("M6：组装时跳过历史中的旧交接书（role=system 且以 [交接书] 开头）", async () => {
    const pipeline = makePipeline(10000);
    const staleBook: ChatMessage = {
      id: "hb1",
      role: "system",
      content: [
        {
          type: "text",
          text:
            "[交接书] 上下文水位撞顶，本轮任务未完成，换班移交（第 1/5 棒）。\n" +
            "【已完成】…\n【未来方向】…",
        },
      ],
      createdAt: "2026-07-17T00:00:00Z",
    };
    const result = await pipeline.assemble(
      makeInput({ history: [staleBook, ...history(2)] }),
    );

    expect(result.messages.some((m) => m.id === "hb1")).toBe(false);
    expect(result.messages.map(textOf).some((t) => t.startsWith("[交接书]"))).toBe(false);
    // 其余历史照常组装
    expect(result.messages.filter((m) => m.role === "user")).toHaveLength(2);
  });

  it("M6：handoffPinned 置顶注入不受 L3 过滤影响（最新交接书仍置顶）", async () => {
    const pipeline = makePipeline(10000);
    const staleBook: ChatMessage = {
      id: "hb1",
      role: "system",
      content: [{ type: "text", text: "[交接书] 旧棒次的过期计划" }],
      createdAt: "2026-07-17T00:00:00Z",
    };
    const result = await pipeline.assemble(
      makeInput({
        history: [staleBook, ...history(1)],
        handoffPinned: "[系统提示] 这是上一棒留给你的交接书。\n\n----------\n\n[交接书] 最新计划",
      }),
    );
    // 历史中的旧交接书被过滤；置顶通道的最新交接书在头部（与 L3 过滤不同路径）
    expect(result.messages.some((m) => m.id === "hb1")).toBe(false);
    expect(result.messages[0].role).toBe("system");
    expect(textOf(result.messages[0])).toContain("[交接书] 最新计划");
  });

  it("超预算时按 L3 逐级截断直到满足预算", async () => {
    // 25 条 × 11 单位 ≈ 275；预算 100 → keep-15（165）→ 仍超 → keep-5（55）→ 满足
    const pipeline = makePipeline(100);
    const result = await pipeline.assemble(makeInput({ history: history(25) }));
    const users = result.messages.filter((m) => m.role === "user");
    expect(users).toHaveLength(5);
    expect(users.at(-1)!.id).toBe("h24"); // 保留最新
  });

  it("tools 计入预算：工具描述占用大头时也会触发 L3 截断", async () => {
    // 12 条 × 11 = 132，tools JSON = 60，预算 150 → 超 → keep-5 → 55+60=115 满足
    const pipeline = makePipeline(150);
    const bigTool = { type: "function", function: { name: "x".repeat(45) } }; // JSON ≈ 60
    const result = await pipeline.assemble(
      makeInput({ history: history(12), tools: [bigTool] }),
    );
    expect(result.messages.filter((m) => m.role === "user")).toHaveLength(5);
    expect(result.tools).toHaveLength(1); // 无名前缀工具归 L6-core，不裁剪
  });

  it("兜底：预算极小且无可降层时按现状返回，不死循环、不碰 L1", async () => {
    const pipeline = makePipeline(10);
    const result = await pipeline.assemble(
      makeInput({ mindContext: "x".repeat(100), history: history(2) }),
    );
    const systems = result.messages.filter((m) => m.role === "system");
    expect(systems).toHaveLength(1); // L1 永不压缩
    expect(result.messages.filter((m) => m.role === "user")).toHaveLength(2);
  });

  it("topicSummaries 伪装成 user 历史消息注入（自然化、非 system 元信息）", async () => {
    const pipeline = makePipeline(10000);
    const result = await pipeline.assemble(
      makeInput({
        history: history(2),
        topicSummaries: [topicSummary("旧话题A", "旧话题A的摘要"), topicSummary("旧话题B", "旧话题B的摘要")],
      }),
    );
    expect(result.messages.every((m) => m.role !== "system")).toBe(true);
    const users = result.messages.filter((m) => m.role === "user").map(textOf);
    expect(users.some((t) => t.includes("用户之前聊过") && t.includes("旧话题A的摘要"))).toBe(true);
    expect(users.some((t) => t.includes("旧话题B的摘要"))).toBe(true);
    // 摘要 createdAt(07-10) 早于 history(07-17)：按时间归并排在历史之前
    const topicIdx = result.messages.findIndex((m) => m.id === "topic-旧话题A");
    const historyIdx = result.messages.findIndex((m) => m.id === "h0");
    expect(topicIdx).toBeGreaterThanOrEqual(0);
    expect(topicIdx).toBeLessThan(historyIdx);
  });

  it("超预算时先丢 L5 再截 L3：丢弃摘要后满足预算则历史完整保留", async () => {
    // l3：5 条 × 13 = 65；l5 摘要消息约 100；预算 100 → 丢 L5 后 65 ≤ 100
    const pipeline = makePipeline(100);
    const result = await pipeline.assemble(
      makeInput({
        history: history(5),
        topicSummaries: [topicSummary("tp1", "S".repeat(60))],
      }),
    );
    expect(result.messages.some((m) => m.id === "topic-tp1")).toBe(false);
    expect(result.messages.filter((m) => m.role === "user")).toHaveLength(5);
  });
});

describe("M3：降级可观测日志", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("未超预算：不打任何降级日志", async () => {
    const debug = vi.spyOn(logger, "debug").mockImplementation(() => {});
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    await makePipeline(10000).assemble(makeInput({ history: history(3) }));
    expect(debug).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("超预算：每步降级打 debug，含 step 名、agentId、预算使用", async () => {
    const debug = vi.spyOn(logger, "debug").mockImplementation(() => {});
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    // 25 条 → keep-15（>20）→ 仍超 → keep-5（15>10）→ 满足
    await makePipeline(100).assemble(makeInput({ agentId: "agent-x", history: history(25) }));
    const logs = debug.mock.calls.map((c) => String(c[0]));
    expect(logs).toHaveLength(2);
    expect(logs[0]).toContain("l3:keep-15");
    expect(logs[1]).toContain("l3:keep-5");
    expect(logs[0]).toContain("agent-x");
    expect(logs[0]).toMatch(/total=\d+.*budget=\d+/);
  });

  it("兜底（无可再降）：打 warn 一次，含 agentId 与 total/budget", async () => {
    vi.spyOn(logger, "debug").mockImplementation(() => {});
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    await makePipeline(10).assemble(
      makeInput({ agentId: "agent-y", mindContext: "x".repeat(100), history: history(2) }),
    );
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0][0]);
    expect(msg).toContain("agent-y");
    expect(msg).toMatch(/total=\d+/);
    expect(msg).toMatch(/budget=\d+/);
  });

  it("降级顺序：l5:drop 先于 l3 截断", async () => {
    const debug = vi.spyOn(logger, "debug").mockImplementation(() => {});
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    // l3：25 条 × 13 = 325；l5 ≈ 100；预算 300 → l5:drop（325 仍超）→ l3:keep-15（195）满足
    const result = await makePipeline(300).assemble(
      makeInput({ history: history(25), topicSummaries: [topicSummary("tp1", "S".repeat(60))] }),
    );
    expect(result.messages.filter((m) => m.role === "user")).toHaveLength(15);
    const logs = debug.mock.calls.map((c) => String(c[0]));
    expect(logs[0]).toContain("l5:drop");
    expect(logs[1]).toContain("l3:keep-15");
  });

  it("semanticMemories 伪装成 user 历史消息，跨场景自然化标注", async () => {
    const pipeline = makePipeline(10000);
    const result = await pipeline.assemble(
      makeInput({
        history: history(1),
        semanticMemories: [
          { id: "m1", content: "本场景记忆", similarity: 0.9, score: 0.9, createdAt: "2026-07-20T00:00:00Z" },
          { id: "m2", content: "跨场景记忆", similarity: 0.8, score: 0.8, source: "session_x", createdAt: "2026-07-20T00:00:00Z" },
        ],
      }),
    );
    expect(result.messages.every((m) => m.role !== "system")).toBe(true);
    const users = result.messages.filter((m) => m.role === "user").map(textOf);
    expect(users.some((t) => t.includes("用户之前提到过") && t.includes("本场景记忆"))).toBe(true);
    expect(users.some((t) => t.includes("另一个对话") && t.includes("跨场景记忆"))).toBe(true);
    // 不再有 [来自: ...] 元信息标注
    expect(users.join("")).not.toContain("[来自:");
  });

  it("降级时 L4 按 score 降序保留高相关片段", async () => {
    // 12 条片段：m10(0.5)/m11(0.45) 被置信度过滤，剩 10 条（6 high + 4 fuzzy）。
    // 预算 300：10 条 ≈ 600 超 → l4:keep-5（5 条 high ≈ 245）满足
    const pipeline = makePipeline(300);
    const result = await pipeline.assemble(
      makeInput({
        history: [],
        semanticMemories: Array.from({ length: 12 }, (_, i) => ({
          id: `m${i}`,
          content: `内容${i}${"x".repeat(6)}`,
          similarity: 1 - i * 0.05,
          score: 1 - i * 0.05,
          createdAt: "2026-07-20T00:00:00Z",
        })),
      }),
    );
    const text = result.messages.map(textOf).join("");
    for (let i = 0; i < 5; i++) expect(text).toContain(`内容${i}`);
    expect(text).not.toContain("内容5");
    expect(text).not.toContain("内容11");
  });
});

describe("最终设计：置信度过滤 / 多轮去重 / 失败告知 / 缓存前缀", () => {
  it("score ≤ 0.5 的记忆被过滤，不参与注入", async () => {
    const pipeline = makePipeline(10000);
    const result = await pipeline.assemble(
      makeInput({
        semanticMemories: [
          { id: "low", content: "低相关记忆", similarity: 0.5, score: 0.5, createdAt: "2026-07-20T00:00:00Z" },
          { id: "high", content: "高相关记忆", similarity: 0.9, score: 0.9, createdAt: "2026-07-20T00:00:00Z" },
        ],
      }),
    );
    const all = result.messages.map(textOf).join("");
    expect(all).not.toContain("低相关记忆");
    expect(all).toContain("高相关记忆");
  });

  it("多轮去重：同一会话已注入的记忆与摘要不重复注入", async () => {
    const pipeline = makePipeline(10000);
    const input = makeInput({
      sourceId: "sess-1",
      semanticMemories: [
        { id: "m1", content: "记忆一", similarity: 0.9, score: 0.9, createdAt: "2026-07-20T00:00:00Z" },
      ],
      topicSummaries: [topicSummary("tp1", "摘要一")],
    });
    const first = await pipeline.assemble(input);
    expect(first.messages.map(textOf).join("")).toContain("记忆一");
    expect(first.messages.map(textOf).join("")).toContain("摘要一");

    const second = await pipeline.assemble(input);
    const all = second.messages.map(textOf).join("");
    expect(all).not.toContain("记忆一");
    expect(all).not.toContain("摘要一");
  });

  it("S4：syncMaxContextTokens 不重建实例——sync 前后同条目不重复注入（去重状态保留）", async () => {
    const pipeline = makePipeline(10000);
    const memory = { id: "m1", content: "记忆一", similarity: 0.9, score: 0.9, createdAt: "2026-07-20T00:00:00Z" };
    const input = makeInput({ sourceId: "sess-1", semanticMemories: [memory] });

    const before = await pipeline.assemble(input);
    expect(before.messages.map(textOf).join("")).toContain("记忆一");

    // 热更窗口（H2）：sync 只改预算，不重建实例
    expect(pipeline.syncMaxContextTokens(32000)).toBe(true);

    // sync 后同条目再次出现：injectedBySource 去重状态保留，不重复注入
    const after = await pipeline.assemble(input);
    expect(after.messages.map(textOf).join("")).not.toContain("记忆一");
  });

  it("去重按会话隔离：新会话可再次注入同一记忆", async () => {
    const pipeline = makePipeline(10000);
    const memory = { id: "m1", content: "记忆一", similarity: 0.9, score: 0.9, createdAt: "2026-07-20T00:00:00Z" };
    await pipeline.assemble(makeInput({ sourceId: "sess-1", semanticMemories: [memory] }));
    const other = await pipeline.assemble(makeInput({ sourceId: "sess-2", semanticMemories: [memory] }));
    expect(other.messages.map(textOf).join("")).toContain("记忆一");
  });

  it("M10：一次性会话（subagent_/blueprint:）不登记去重状态——同条目再来仍注入", async () => {
    const pipeline = makePipeline(10000);
    const memory = { id: "m1", content: "记忆一", similarity: 0.9, score: 0.9, createdAt: "2026-07-20T00:00:00Z" };
    for (const sourceId of ["subagent_abc", "blueprint:exec-1"]) {
      const first = await pipeline.assemble(makeInput({ sourceId, semanticMemories: [memory] }));
      expect(first.messages.map(textOf).join("")).toContain("记忆一");
      // 一次性会话不登记：同前缀会话再次经过时不被去重误伤
      const second = await pipeline.assemble(makeInput({ sourceId, semanticMemories: [memory] }));
      expect(second.messages.map(textOf).join("")).toContain("记忆一");
    }
  });

  it("M10：一次性会话不挤占 64 槽 FIFO——真实会话的去重状态不被逐出", async () => {
    const pipeline = makePipeline(10000);
    const memory = { id: "m1", content: "记忆一", similarity: 0.9, score: 0.9, createdAt: "2026-07-20T00:00:00Z" };
    // 真实会话先登记
    await pipeline.assemble(makeInput({ sourceId: "sess-1", semanticMemories: [memory] }));
    // 64 个一次性会话经过：若登记会撑满 MAX_DEDUP_SESSIONS(64) 并逐出 sess-1
    for (let i = 0; i < 64; i++) {
      await pipeline.assemble(makeInput({ sourceId: `subagent_${i}`, semanticMemories: [memory] }));
    }
    // sess-1 的去重状态仍在：同条目不重复注入
    const again = await pipeline.assemble(makeInput({ sourceId: "sess-1", semanticMemories: [memory] }));
    expect(again.messages.map(textOf).join("")).not.toContain("记忆一");
  });

  it("M10：单会话去重条数上限——超栽最旧条目，极旧记忆可再次注入", async () => {
    const pipeline = makePipeline(10000);
    const oldest = { id: "m0", content: "最旧记忆", similarity: 0.9, score: 0.9, createdAt: "2026-07-20T00:00:00Z" };
    // 首轮注入 m0（登记为第 1 条）
    await pipeline.assemble(makeInput({ sourceId: "sess-1", semanticMemories: [oldest] }));
    // 逐轮注入 256 条新记忆：达到 256 条上限时最旧的 m0 被逐出
    for (let i = 1; i <= 256; i++) {
      await pipeline.assemble(
        makeInput({
          sourceId: "sess-1",
          semanticMemories: [
            { id: `m${i}`, content: `记忆${i}`, similarity: 0.9, score: 0.9, createdAt: "2026-07-20T00:00:00Z" },
          ],
        }),
      );
    }
    // m0 已被逐出去重状态：再次出现时可注入
    const replay = await pipeline.assemble(makeInput({ sourceId: "sess-1", semanticMemories: [oldest] }));
    expect(replay.messages.map(textOf).join("")).toContain("最旧记忆");
    // 最近的 m256 仍在去重状态内：不重复注入
    const latest = { id: "m256", content: "记忆256", similarity: 0.9, score: 0.9, createdAt: "2026-07-20T00:00:00Z" };
    const deduped = await pipeline.assemble(makeInput({ sourceId: "sess-1", semanticMemories: [latest] }));
    expect(deduped.messages.map(textOf).join("")).not.toContain("记忆256");
  });

  it("被降级丢弃的记忆不计入已注入，下一轮预算宽裕时仍可注入", async () => {
    const pipeline = makePipeline(150);
    const memory = { id: "m1", content: "珍贵记忆", similarity: 0.9, score: 0.9, createdAt: "2026-07-20T00:00:00Z" };
    // 第一轮：25 条 history 挤爆预算，L4 走 l4:drop 被整体丢弃
    const squeezed = await pipeline.assemble(
      makeInput({ history: history(25), semanticMemories: [memory] }),
    );
    expect(squeezed.messages.map(textOf).join("")).not.toContain("珍贵记忆");
    // 第二轮：history 变短，预算宽裕 → 记忆应注入（未被误标记为已注入）
    const relaxed = await pipeline.assemble(
      makeInput({ history: history(2), semanticMemories: [memory] }),
    );
    expect(relaxed.messages.map(textOf).join("")).toContain("珍贵记忆");
  });

  it("检索失败透传：尾随 system 消息明确告知", async () => {
    const pipeline = makePipeline(10000);
    const result = await pipeline.assemble(
      makeInput({ history: history(1), retrievalFailed: true }),
    );
    const last = result.messages.at(-1)!;
    expect(last.role).toBe("system");
    expect(textOf(last)).toContain("记忆检索暂时不可用");
    // 固定前缀不被污染：失败提示在 messages 末尾
    expect(result.messages.findIndex((m) => m.id === "h0")).toBeLessThan(
      result.messages.length - 1,
    );
  });

  it("缓存前缀稳定：L4/L5/历史变化不改变头部 system 消息内容与位置", async () => {
    const pipeline = makePipeline(10000);
    const base = { mindContext: "人格内容" };
    const r1 = await pipeline.assemble(
      makeInput({
        ...base,
        sourceId: "s1",
        history: history(2),
        semanticMemories: [
          { id: "m1", content: "记忆一", similarity: 0.9, score: 0.9, createdAt: "2026-07-20T00:00:00Z" },
        ],
      }),
    );
    const r2 = await pipeline.assemble(
      makeInput({
        ...base,
        sourceId: "s2",
        history: history(3),
        semanticMemories: [
          { id: "m2", content: "完全不同的记忆", similarity: 0.95, score: 0.95, createdAt: "2026-07-21T00:00:00Z" },
        ],
        topicSummaries: [topicSummary("tp9", "另一个摘要")],
      }),
    );
    // 头部 L1 system 内容与位置完全一致 → 前缀缓存命中
    expect(r1.messages[0].role).toBe("system");
    expect(textOf(r1.messages[0])).toBe("人格内容");
    expect(r2.messages[0].role).toBe("system");
    expect(textOf(r2.messages[0])).toBe(textOf(r1.messages[0]));
  });
});

describe("L6-ext 工具裁剪（决策 1：mcp__/ext__ 前缀分流）", () => {
  /** 生产真形状：OpenAI function 格式（agent-worker.ts:652-659 同款构造） */
  function coreTool(name: string): unknown {
    return { type: "function", function: { name, description: "core", parameters: {} } };
  }
  function extTool(name: string, descLen = 200): unknown {
    return {
      type: "function",
      function: { name, description: "x".repeat(descLen), parameters: {} },
    };
  }
  function toolNames(tools: unknown[]): string[] {
    return tools.map((t) => (t as { function: { name: string } }).function.name);
  }

  it("混合 tools 分流计数正确：core 全保留、ext 归可裁层，输出 core 在前 ext 在后", async () => {
    const debug = vi.spyOn(logger, "debug").mockImplementation(() => {});
    try {
      const pipeline = makePipeline(100_000);
      const result = await pipeline.assemble(
        makeInput({
          history: history(2),
          tools: [
            coreTool("read_file"),
            extTool("mcp__fs__read", 10),
            coreTool("dispatch_subagent"),
            extTool("ext__hello__greet", 10),
            coreTool("generate_image"),
          ],
        }),
      );
      expect(toolNames(result.tools)).toEqual([
        "read_file",
        "dispatch_subagent",
        "generate_image",
        "mcp__fs__read",
        "ext__hello__greet",
      ]);
      expect(
        debug.mock.calls.some((c) => String(c[0]).includes("L6 分流：core=3 ext=2")),
      ).toBe(true);
    } finally {
      debug.mockRestore();
    }
  });

  it("超预算：l6ext:halve 一步即满足——ext 裁掉后半（注册序保前部），core 全保留，L3 不动", async () => {
    // history(3)=39；tools JSON=1324（core 2 件 177 + ext 4 件 1140）；总量 1363
    // 预算 850：超 → halve（4→2，tools 752，total 791 ≤ 850）停，不碰 L3
    const debug = vi.spyOn(logger, "debug").mockImplementation(() => {});
    try {
      const pipeline = makePipeline(850);
      const result = await pipeline.assemble(
        makeInput({
          history: history(3),
          tools: [
            coreTool("read_file"),
            coreTool("write_file"),
            extTool("mcp__a__t1"),
            extTool("mcp__a__t2"),
            extTool("mcp__b__t3"),
            extTool("ext__p__t4"),
          ],
        }),
      );
      expect(toolNames(result.tools)).toEqual([
        "read_file",
        "write_file",
        "mcp__a__t1",
        "mcp__a__t2",
      ]);
      // L3 未裁：3 条历史完整保留
      expect(result.messages.filter((m) => m.role === "user")).toHaveLength(3);
      const steps = debug.mock.calls.map((c) => String(c[0]));
      expect(steps.some((s) => s.includes("降级 l6ext:halve"))).toBe(true);
      expect(steps.some((s) => s.includes("降级 l3:"))).toBe(false);
    } finally {
      debug.mockRestore();
    }
  });

  it("超预算：halve 不够再 drop 清空 ext——仍先于任何 L3 步骤，core 一件不裁", async () => {
    // 同上乘组，预算 500：halve 后 total 791 仍超 → drop（ext 清空，total 219 ≤ 500）
    const debug = vi.spyOn(logger, "debug").mockImplementation(() => {});
    try {
      const pipeline = makePipeline(500);
      const result = await pipeline.assemble(
        makeInput({
          history: history(3),
          tools: [
            coreTool("read_file"),
            coreTool("dispatch_subagent"),
            extTool("mcp__a__t1"),
            extTool("mcp__a__t2"),
            extTool("mcp__b__t3"),
            extTool("ext__p__t4"),
          ],
        }),
      );
      expect(toolNames(result.tools)).toEqual(["read_file", "dispatch_subagent"]);
      expect(result.messages.filter((m) => m.role === "user")).toHaveLength(3);
      const steps = debug.mock.calls.map((c) => String(c[0]));
      expect(steps.some((s) => s.includes("降级 l6ext:drop"))).toBe(true);
      expect(steps.some((s) => s.includes("降级 l3:"))).toBe(false);
    } finally {
      debug.mockRestore();
    }
  });

  it("无 ext 时与现状恒等：既有用例即钉（混合名/无名字工具全归 core，永不裁）", async () => {
    // 极预算压到必须动 L3：core 工具再大也不进裁剪序列
    const pipeline = makePipeline(150);
    const bigCore = { type: "function", function: { name: "x".repeat(45) } }; // 无名前缀 → core
    const result = await pipeline.assemble(
      makeInput({ history: history(12), tools: [bigCore, { nope: true }] }),
    );
    expect(result.tools).toHaveLength(2);
    expect(result.messages.filter((m) => m.role === "user")).toHaveLength(5);
  });
});
