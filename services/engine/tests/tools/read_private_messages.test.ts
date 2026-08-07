import { describe, it, expect, vi } from "vitest";
import { readPrivateMessagesTool } from "../../src/tools/builtin/read_private_messages.js";
import { getBuiltinTools } from "../../src/tools/builtin/index.js";
import type { ToolContext, ToolResult } from "../../src/tools/types.js";
import type { IntermindService } from "../../src/intermind/service.js";
import type { ChatMessageRecord } from "@mindcloud/shared";

function record(over: Partial<ChatMessageRecord>): ChatMessageRecord {
  return {
    id: "m1",
    sessionId: "intermind:a2",
    role: "user",
    content: [{ type: "text", text: "你好" }],
    agentId: "a2",
    createdAt: "2026-08-07T00:00:00.000Z",
    ...over,
  };
}

function makeService(over: Partial<IntermindService> = {}): IntermindService {
  return {
    listMessages: vi.fn(async () => []),
    ...over,
  } as unknown as IntermindService;
}

function makeCtx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    agentId: "a1",
    workspaceDir: "/tmp",
    approve: async () => true,
    services: { intermindService: makeService() },
    ...over,
  };
}

describe("read_private_messages 工具", () => {
  it("免审批、memory/read 声明，且已注册进内置工具表", () => {
    expect(readPrivateMessagesTool.requiresApproval).toBe(false);
    expect(readPrivateMessagesTool.accesses).toContainEqual({
      resource: "memory",
      action: "read",
    });
    expect(getBuiltinTools().map((t) => t.name)).toContain("read_private_messages");
  });

  it("读全文：返回完整内容与方向/时间，缺省 limit=50", async () => {
    const service = makeService({
      listMessages: vi.fn(async () => [
        record({
          id: "m-in",
          agentId: "a2",
          content: [{ type: "text", text: "长信全文".repeat(80) }],
        }),
        record({
          id: "m-out",
          agentId: "a1",
          content: [{ type: "text", text: "回信" }],
        }),
      ]),
    });
    const result: ToolResult = await readPrivateMessagesTool.execute(
      makeCtx({ services: { intermindService: service } }),
      { from: "a2" },
    );

    expect(service.listMessages).toHaveBeenCalledWith("a1", "a2", { limit: 50 });
    expect(result.success).toBe(true);
    const output = result.output as {
      from: string;
      sessionId: string;
      count: number;
      messages: Array<{ id: string; direction: string; from: string; to: string; createdAt: string; text: string }>;
    };
    expect(output).toMatchObject({ from: "a2", sessionId: "intermind:a2", count: 2 });
    expect(output.messages[0]).toMatchObject({
      id: "m-in",
      direction: "received",
      from: "a2",
      to: "a1",
      createdAt: "2026-08-07T00:00:00.000Z",
      text: "长信全文".repeat(80),
    });
    expect(output.messages[1]).toMatchObject({ direction: "sent", from: "a1", to: "a2", text: "回信" });
  });

  it("limit 参数透传", async () => {
    const service = makeService();
    const result = await readPrivateMessagesTool.execute(
      makeCtx({ services: { intermindService: service } }),
      { from: "a2", limit: 7 },
    );
    expect(result.success).toBe(true);
    expect(service.listMessages).toHaveBeenCalledWith("a1", "a2", { limit: 7 });
  });

  it("傀儡上下文：明确拒绝（傀儡无社交权），不调用 service", async () => {
    const service = makeService();
    const result = await readPrivateMessagesTool.execute(
      makeCtx({ isPuppet: true, services: { intermindService: service } }),
      { from: "a2" },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("傀儡无社交权");
    expect(service.listMessages).not.toHaveBeenCalled();
  });

  it("对端无会话：返回空列表，不报错", async () => {
    const service = makeService();
    const result: ToolResult = await readPrivateMessagesTool.execute(
      makeCtx({ services: { intermindService: service } }),
      { from: "ghost" },
    );
    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({ from: "ghost", count: 0, messages: [] });
  });

  it("service 未注入：明确报错", async () => {
    const result = await readPrivateMessagesTool.execute(makeCtx({ services: {} }), {
      from: "a2",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Intermind service not available");
  });

  it("参数校验：缺 from / limit 非法返回参数错误且不调用 service", async () => {
    const service = makeService();
    const ctx = makeCtx({ services: { intermindService: service } });

    const missing = await readPrivateMessagesTool.execute(ctx, {});
    expect(missing.success).toBe(false);
    expect(String(missing.error)).toContain("from");

    const zero = await readPrivateMessagesTool.execute(ctx, { from: "a2", limit: 0 });
    expect(zero.success).toBe(false);
    expect(String(zero.error)).toContain("limit");

    const tooMany = await readPrivateMessagesTool.execute(ctx, { from: "a2", limit: 999 });
    expect(tooMany.success).toBe(false);
    expect(String(tooMany.error)).toContain("limit");

    expect(service.listMessages).not.toHaveBeenCalled();
  });
});
