import { describe, it, expect, vi } from "vitest";
import { recallTool } from "../../src/tools/builtin/recall.js";
import { getBuiltinTools } from "../../src/tools/builtin/index.js";
import type { ToolContext, ToolResult } from "../../src/tools/types.js";
import type { RecallService } from "../../src/memory/recall.js";

function makeService(over: Partial<RecallService> = {}): RecallService {
  return {
    listTopics: vi.fn(async () => ({ items: [], total: 0 })),
    readByTopicId: vi.fn(async () => ({ items: [], total: 0 })),
    readByQuery: vi.fn(async () => ({ items: [], total: 0 })),
    ...over,
  } as unknown as RecallService;
}

function makeCtx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    agentId: "a1",
    workspaceDir: "/tmp",
    approve: async () => true,
    services: { recallService: makeService() },
    ...over,
  };
}

function recallMessage(id: string, text: string, createdAt = "2026-08-07T00:00:00.000Z") {
  return { id, role: "user" as const, text, createdAt, sessionId: "s1" };
}

describe("recall 工具", () => {
  it("免审批、memory/read 声明，且已注册进内置工具表", () => {
    expect(recallTool.requiresApproval).toBe(false);
    expect(recallTool.accesses).toContainEqual({ resource: "memory", action: "read" });
    expect(getBuiltinTools().map((t) => t.name)).toContain("recall");
  });

  it("topics：返回压缩档目录（倒序由 service 保证）+ 翻页指引", async () => {
    const service = makeService({
      listTopics: vi.fn(async () => ({
        total: 25,
        items: Array.from({ length: 20 }, (_, i) => ({
          topicId: `tp_${i}`,
          label: `话题 ${i}`,
          startedAt: "2026-08-07T00:00:00.000Z",
          endedAt: "2026-08-07T01:00:00.000Z",
          msgCount: 3,
          sourceId: "s1",
        })),
      })),
    });
    const result: ToolResult = await recallTool.execute(
      makeCtx({ services: { recallService: service } }),
      { action: "topics" },
    );
    expect(result.success).toBe(true);
    const output = result.output as {
      action: string;
      count: number;
      total: number;
      topics: unknown[];
      hint: string;
    };
    expect(output.action).toBe("topics");
    expect(output.count).toBe(20);
    expect(output.total).toBe(25);
    expect(output.topics).toHaveLength(20);
    expect(output.hint).toBe("记忆目录共 25 个话题，还有 5 个可继续翻（offset += 20）");
    expect(service.listTopics).toHaveBeenCalledWith("a1", { limit: undefined, offset: undefined });
  });

  it("read by topicId：返回归档原文消息与时间戳 + 尾部翻页指引", async () => {
    const service = makeService({
      readByTopicId: vi.fn(async () => ({
        total: 2,
        items: [
          recallMessage("m1", "原文一"),
          recallMessage("m2", "原文二", "2026-08-07T01:00:00.000Z"),
        ],
      })),
    });
    const result = await recallTool.execute(
      makeCtx({ services: { recallService: service } }),
      { action: "read", topicId: "tp_1", limit: 10, offset: 0 },
    );
    expect(result.success).toBe(true);
    const output = result.output as {
      action: string;
      topicId: string;
      count: number;
      total: number;
      messages: Array<{ id: string; text: string; createdAt: string }>;
      hint: string;
    };
    expect(output.action).toBe("read");
    expect(output.topicId).toBe("tp_1");
    expect(output.messages[0]).toMatchObject({ id: "m1", text: "原文一", createdAt: "2026-08-07T00:00:00.000Z" });
    expect(output.hint).toBe("这是归档原文回忆，共 2 条，还有 0 条可继续翻（offset += 2）");
    expect(service.readByTopicId).toHaveBeenCalledWith("a1", "tp_1", { limit: 10, offset: 0 });
  });

  it("read by query：关键词命中返回，未命中返回友好空", async () => {
    const hitService = makeService({
      readByQuery: vi.fn(async () => ({
        total: 1,
        items: [recallMessage("m1", "部署方案")],
      })),
    });
    const hit = await recallTool.execute(
      makeCtx({ services: { recallService: hitService } }),
      { action: "read", query: "部署" },
    );
    expect(hit.success).toBe(true);
    expect((hit.output as { count: number }).count).toBe(1);

    const emptyService = makeService({
      readByQuery: vi.fn(async () => ({ items: [], total: 0 })),
    });
    const empty = await recallTool.execute(
      makeCtx({ services: { recallService: emptyService } }),
      { action: "read", query: "不存在词" },
    );
    expect(empty.success).toBe(true);
    const out = empty.output as { count: number; messages: unknown[]; hint: string };
    expect(out.count).toBe(0);
    expect(out.messages).toEqual([]);
    expect(out.hint).toBe("没有找到匹配「不存在词」的归档消息");
  });

  it("分页：limit/offset 透传，翻页指引按实际返回条数计", async () => {
    const service = makeService({
      readByQuery: vi.fn(async () => ({
        total: 5,
        items: [recallMessage("m3", "三"), recallMessage("m2", "二")],
      })),
    });
    const result = await recallTool.execute(
      makeCtx({ services: { recallService: service } }),
      { action: "read", query: "部署", limit: 2, offset: 2 },
    );
    expect(result.success).toBe(true);
    expect(service.readByQuery).toHaveBeenCalledWith("a1", "部署", { limit: 2, offset: 2 });
    expect((result.output as { hint: string }).hint).toBe(
      "这是归档原文回忆，共 5 条，还有 1 条可继续翻（offset += 2）",
    );
  });

  it("傀儡上下文：明确拒绝（傀儡无记忆），不调用 service", async () => {
    const service = makeService();
    const result = await recallTool.execute(
      makeCtx({ isPuppet: true, services: { recallService: service } }),
      { action: "topics" },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("傀儡无记忆");
    expect(service.listTopics).not.toHaveBeenCalled();
  });

  it("service 未注入：明确报错", async () => {
    const result = await recallTool.execute(makeCtx({ services: {} }), { action: "topics" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Recall service not available");
  });

  it("参数校验：read 必须二选一、topics 不得带 topicId/query、limit 上限 50", async () => {
    const service = makeService();
    const ctx = makeCtx({ services: { recallService: service } });

    const noKey = await recallTool.execute(ctx, { action: "read" });
    expect(noKey.success).toBe(false);
    expect(String(noKey.error)).toContain("topicId 或 query");

    const both = await recallTool.execute(ctx, { action: "read", topicId: "t", query: "q" });
    expect(both.success).toBe(false);
    expect(String(both.error)).toContain("topicId 或 query");

    const topicsWithKey = await recallTool.execute(ctx, { action: "topics", topicId: "t" });
    expect(topicsWithKey.success).toBe(false);

    const tooMany = await recallTool.execute(ctx, { action: "topics", limit: 51 });
    expect(tooMany.success).toBe(false);
    expect(String(tooMany.error)).toContain("limit");

    expect(service.listTopics).not.toHaveBeenCalled();
  });

  it("截断护栏：单条超长截断标记 + 总输出预算从尾部丢弃并更新翻页指引", async () => {
    const longText = "长".repeat(1500);
    const service = makeService({
      readByQuery: vi.fn(async () => ({
        total: 20,
        items: Array.from({ length: 20 }, (_, i) => recallMessage(`m${i}`, longText)),
      })),
    });
    const result = await recallTool.execute(
      makeCtx({ services: { recallService: service } }),
      { action: "read", query: "长", limit: 20 },
    );
    expect(result.success).toBe(true);
    const output = result.output as {
      messages: Array<{ text: string; truncated?: boolean }>;
      hint: string;
    };
    // 单条截到 1000 字符 + 省略号，并带 truncated 标记
    expect(output.messages[0]!.text.length).toBe(1001);
    expect(output.messages[0]!.text.endsWith("…")).toBe(true);
    expect(output.messages[0]!.truncated).toBe(true);
    // 20 × 1001（1000 + 省略号）字符超 8000 总预算：保留 7 条，翻页指引按实际返回条数更新
    expect(output.messages.length).toBe(7);
    expect(output.hint).toBe("这是归档原文回忆，共 20 条，还有 13 条可继续翻（offset += 7）");
  });
});
