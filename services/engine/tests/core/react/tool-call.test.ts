import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { runToolCallBatch, type ToolExecutionContext } from "../../../src/core/react/tool-call.js";
import type { Tool } from "../../../src/tools/types.js";
import type { LLMEvent } from "../../../src/provider/types.js";

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
