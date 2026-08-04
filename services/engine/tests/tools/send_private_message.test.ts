import { describe, it, expect, vi } from "vitest";
import { sendPrivateMessageTool } from "../../src/tools/builtin/send_private_message.js";
import { getBuiltinTools } from "../../src/tools/builtin/index.js";
import type { ToolContext, ToolResult } from "../../src/tools/types.js";
import type { IntermindService } from "../../src/intermind/service.js";

function makeService(over: Partial<IntermindService> = {}): IntermindService {
  return {
    send: vi.fn(async () => ({
      messageId: "m1",
      recipientSessionId: "intermind:a2",
      woke: true,
    })),
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

describe("send_private_message 工具", () => {
  it("免审批、memory/write 声明，且已注册进内置工具表", () => {
    expect(sendPrivateMessageTool.requiresApproval).toBe(false);
    expect(sendPrivateMessageTool.accesses).toContainEqual({
      resource: "memory",
      action: "write",
    });
    expect(getBuiltinTools().map((t) => t.name)).toContain("send_private_message");
  });

  it("写信成功：调用 service.send（wake=true）并返回消息 id", async () => {
    const service = makeService();
    const result = await sendPrivateMessageTool.execute(makeCtx({ services: { intermindService: service } }), {
      to: "a2",
      content: "你好",
    });
    expect(result.success).toBe(true);
    expect((result as { output: unknown }).output).toMatchObject({
      messageId: "m1",
      recipientSessionId: "intermind:a2",
      woke: true,
    });
    expect(service.send).toHaveBeenCalledWith("a1", "a2", "你好", { wake: true });
  });

  it("搭车回合（intermindRide=true）：回信只入队不唤醒（wake=false）", async () => {
    const service = makeService();
    const result = await sendPrivateMessageTool.execute(
      makeCtx({ intermindRide: true, services: { intermindService: service } }),
      { to: "a2", content: "回信" },
    );
    expect(result.success).toBe(true);
    expect(service.send).toHaveBeenCalledWith("a1", "a2", "回信", { wake: false });
  });

  it("傀儡上下文：明确拒绝（傀儡无社交权），不调用 service", async () => {
    const service = makeService();
    const result = await sendPrivateMessageTool.execute(
      makeCtx({ isPuppet: true, services: { intermindService: service } }),
      { to: "a2", content: "hi" },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("傀儡无社交权");
    expect(service.send).not.toHaveBeenCalled();
  });

  it("service 未注入：明确报错", async () => {
    const result = await sendPrivateMessageTool.execute(makeCtx({ services: {} }), {
      to: "a2",
      content: "hi",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Intermind service not available");
  });

  it("目标不存在：service 抛错转为结构化错误", async () => {
    const service = makeService({
      send: vi.fn(async () => {
        throw new Error("Agent ghost not found");
      }),
    });
    const result: ToolResult = await sendPrivateMessageTool.execute(
      makeCtx({ services: { intermindService: service } }),
      { to: "ghost", content: "hi" },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Agent ghost not found");
  });

  it("参数校验：空 content / 缺 to 返回参数错误且不调用 service", async () => {
    const service = makeService();
    const ctx = makeCtx({ services: { intermindService: service } });
    const empty = await sendPrivateMessageTool.execute(ctx, { to: "a2", content: "" });
    expect(empty.success).toBe(false);
    expect(String(empty.error)).toContain("content");
    const missing = await sendPrivateMessageTool.execute(ctx, { content: "hi" });
    expect(missing.success).toBe(false);
    expect(String(missing.error)).toContain("to");
    expect(service.send).not.toHaveBeenCalled();
  });
});
