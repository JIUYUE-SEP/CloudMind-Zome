import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { runToolCallBatch, type ToolExecutionContext } from "../../../src/core/react/tool-call.js";
import type { Tool } from "../../../src/tools/types.js";
import type { LLMEvent } from "../../../src/provider/types.js";
import type { ActionRecord } from "../../../src/memory/repositories/types.js";

function makeTool(name: string, execute: Tool["execute"], parameters: Tool["parameters"] = z.object({})): Tool {
  return { name, description: name, parameters, accesses: [], execute };
}

function makeCtx(tools: Tool[], opts?: { approve?: ToolExecutionContext["approve"]; events?: LLMEvent[] }): ToolExecutionContext {
  return {
    agentId: "a1",
    workspaceDir: "/tmp",
    tools: new Map(tools.map((t) => [t.name, t])),
    approve: opts?.approve ?? (async () => true),
    emit: (e) => {
      opts?.events?.push(e);
    },
  };
}

describe("runToolCallBatch 单 call 异常隔离（P3-2，功能 M3 + 质量 M5）", () => {
  it("execute 抛错：本条转 error ToolResult 并发帧，整批不崩、其他 call 正常", async () => {
    const events: LLMEvent[] = [];
    const ctx = makeCtx(
      [
        makeTool("boom", async () => {
          throw new Error("tool exploded");
        }),
        makeTool("fine", async () => ({ success: true, output: "ok" })),
      ],
      { events },
    );

    const results = await runToolCallBatch(
      [
        { toolCallId: "tc-1", name: "boom", arguments: {} },
        { toolCallId: "tc-2", name: "fine", arguments: {} },
      ],
      ctx,
    );

    const byId = new Map(results.map((r) => [r.toolCallId, r.output]));
    expect(JSON.stringify(byId.get("tc-1"))).toContain("tool exploded");
    expect(byId.get("tc-2")).toEqual({ success: true, output: "ok" });
    // 每个 toolCallId 都有 tool.result 帧（无孤儿 toolCall）
    const emittedIds = events
      .filter((e) => e.type === "tool.result")
      .map((e) => (e as { toolCallId: string }).toolCallId);
    expect(emittedIds.sort()).toEqual(["tc-1", "tc-2"]);
  });

  it("approve 抛错：同样单条隔离，execute 未执行", async () => {
    const execute = vi.fn(async () => ({ success: true, output: "ok" }));
    const events: LLMEvent[] = [];
    const ctx = makeCtx([makeTool("guarded", execute)], {
      events,
      approve: async () => {
        throw new Error("approval channel broken");
      },
    });

    const results = await runToolCallBatch([{ toolCallId: "tc-1", name: "guarded", arguments: {} }], ctx);

    expect(JSON.stringify(results[0]!.output)).toContain("approval channel broken");
    expect(execute).not.toHaveBeenCalled();
    expect(events.filter((e) => e.type === "tool.result")).toHaveLength(1);
  });

  it("zod 参数校验失败（质量 M5）：error result + 帧，execute 未执行，后续 call 不受影响", async () => {
    const execute = vi.fn(async () => ({ success: true, output: "ok" }));
    const strict = makeTool("strict", execute, z.object({ value: z.string() }));
    const events: LLMEvent[] = [];
    const ctx = makeCtx([strict, makeTool("fine", async () => ({ success: true, output: "ok" }))], {
      events,
    });

    const results = await runToolCallBatch(
      [
        { toolCallId: "tc-1", name: "strict", arguments: { value: 42 } }, // 类型不符
        { toolCallId: "tc-2", name: "fine", arguments: {} },
      ],
      ctx,
    );

    expect(JSON.stringify(results[0]!.output)).toContain("error");
    expect(execute).not.toHaveBeenCalled();
    expect(results[1]!.output).toEqual({ success: true, output: "ok" });
    const emittedIds = events
      .filter((e) => e.type === "tool.result")
      .map((e) => (e as { toolCallId: string }).toolCallId);
    expect(emittedIds.sort()).toEqual(["tc-1", "tc-2"]);
  });

  it("未知工具：兜底 error result（行为钉住）", async () => {
    const events: LLMEvent[] = [];
    const ctx = makeCtx([], { events });
    const results = await runToolCallBatch([{ toolCallId: "tc-x", name: "ghost", arguments: {} }], ctx);
    expect(JSON.stringify(results[0]!.output)).toContain("Unknown tool");
    expect(events.filter((e) => e.type === "tool.result")).toHaveLength(1);
  });

  it("审批拒绝：error result 同构（行为钉住）", async () => {
    const execute = vi.fn(async () => ({ success: true, output: "ok" }));
    const ctx = makeCtx([makeTool("dangerous", execute)], { approve: async () => false });
    const results = await runToolCallBatch([{ toolCallId: "tc-1", name: "dangerous", arguments: {} }], ctx);
    expect(results[0]!.output).toEqual({ error: "Approval denied" });
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("H1 工具调用落档（recordAction 回调）", () => {
  it("成功/失败/审批拒绝各记一条：id=toolCallId、status 正确、description 含工具名", async () => {
    const records: ActionRecord[] = [];
    const base = makeCtx([
      makeTool("fine", async () => ({ success: true, output: "ok" })),
      makeTool("boom", async () => {
        throw new Error("tool exploded");
      }),
      makeTool("guarded", async () => ({ success: true, output: "never" })),
    ]);
    base.approve = async (name) => name !== "guarded";
    const ctx: ToolExecutionContext = {
      ...base,
      recordAction: (r) => {
        records.push(r);
      },
    };

    const results = await runToolCallBatch(
      [
        { toolCallId: "tc-ok", name: "fine", arguments: {} },
        { toolCallId: "tc-boom", name: "boom", arguments: {} },
        { toolCallId: "tc-denied", name: "guarded", arguments: {} },
      ],
      ctx,
    );

    expect(results).toHaveLength(3);
    expect(records).toHaveLength(3);
    const byId = new Map(records.map((r) => [r.id, r]));
    expect(byId.get("tc-ok")?.status).toBe("completed");
    expect(byId.get("tc-ok")?.description).toContain("fine");
    expect(byId.get("tc-boom")?.status).toBe("failed");
    expect(byId.get("tc-boom")?.description).toContain("boom");
    expect(byId.get("tc-denied")?.status).toBe("failed");
    // 时间戳落成可解析 ISO；单条记录完成即落，createdAt/updatedAt 同值
    expect(Number.isNaN(Date.parse(byId.get("tc-ok")!.createdAt))).toBe(false);
    expect(byId.get("tc-ok")!.updatedAt).toBe(byId.get("tc-ok")!.createdAt);
  });

  it("工具自报失败（success:false）计 failed；参数摘要截断（与审批审计同口径）", async () => {
    const records: ActionRecord[] = [];
    const ctx: ToolExecutionContext = {
      ...makeCtx([makeTool("runner", async () => ({ success: false, error: "exit 1" }))]),
      recordAction: (r) => {
        records.push(r);
      },
    };

    await runToolCallBatch(
      [{ toolCallId: "tc-1", name: "runner", arguments: { command: "x".repeat(1000) } }],
      ctx,
    );

    expect(records).toHaveLength(1);
    expect(records[0]!.status).toBe("failed");
    // command 摘要截 500（approval-audit.summarizeArgs 口径），1000 字符原文不落盘
    expect(records[0]!.description).toBe(`runner(command=${"x".repeat(500)}…(1000 chars))`);
  });

  it("recordAction 抛错：不影响工具结果与 tool.result 帧", async () => {
    const events: LLMEvent[] = [];
    const ctx: ToolExecutionContext = {
      ...makeCtx([makeTool("fine", async () => ({ success: true, output: "ok" }))], { events }),
      recordAction: () => {
        throw new Error("sink broken");
      },
    };

    const results = await runToolCallBatch([{ toolCallId: "tc-1", name: "fine", arguments: {} }], ctx);

    expect(results[0]!.output).toEqual({ success: true, output: "ok" });
    expect(events.filter((e) => e.type === "tool.result")).toHaveLength(1);
  });
});
