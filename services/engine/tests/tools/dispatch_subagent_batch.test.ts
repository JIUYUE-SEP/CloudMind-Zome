/**
 * dispatch_subagent_batch 工具测试：
 * ① 模板/items 硬校验全分支（任何一条不满足直接拒绝，swarm 不启动）；
 * ② <agent_swarm_result> XML 原位聚合渲染（completed/failed 各归其位、XML 转义）。
 */
import { describe, it, expect } from "vitest";
import { dispatchSubagentBatchTool } from "../../src/tools/builtin/dispatch_subagent_batch.js";
import type { SubagentSwarm, SwarmItemResult } from "../../src/subagent/batch.js";
import type { ToolContext } from "../../src/tools/types.js";

interface SwarmCall {
  agentId: string;
  items: Array<{ prompt: string; item: string }>;
}

function makeCtx(results?: SwarmItemResult[]): { ctx: ToolContext; calls: SwarmCall[] } {
  const calls: SwarmCall[] = [];
  const swarm = {
    run: async (agentId: string, items: Array<{ prompt: string; item: string }>) => {
      calls.push({ agentId, items });
      return (
        results ??
        items.map((it, index) => ({ index, item: it.item, status: "completed" as const, output: `done:${it.item}`, taskId: `t${index}` }))
      );
    },
  } as unknown as SubagentSwarm;
  return {
    calls,
    ctx: {
      agentId: "a1",
      workspaceDir: ".",
      approve: async () => true,
      services: { subagentSwarm: swarm },
    },
  };
}

describe("① 硬校验全分支（swarm 不启动）", () => {
  it("模板缺 {{item}} 占位符", async () => {
    const { ctx, calls } = makeCtx();
    const result = await dispatchSubagentBatchTool.execute(ctx, {
      prompt_template: "没有占位符",
      items: ["a", "b"],
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("{{item}}");
    expect(calls).toHaveLength(0);
  });

  it("items 少于 2 个", async () => {
    const { ctx, calls } = makeCtx();
    const result = await dispatchSubagentBatchTool.execute(ctx, {
      prompt_template: "处理 {{item}}",
      items: ["a"],
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("至少需要 2 个");
    expect(calls).toHaveLength(0);
  });

  it("items 超过 16 个", async () => {
    const { ctx, calls } = makeCtx();
    const result = await dispatchSubagentBatchTool.execute(ctx, {
      prompt_template: "处理 {{item}}",
      items: Array.from({ length: 17 }, (_, i) => `it${i}`),
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("至多 16 个");
    expect(calls).toHaveLength(0);
  });

  it("展开后简报重复", async () => {
    const { ctx, calls } = makeCtx();
    const result = await dispatchSubagentBatchTool.execute(ctx, {
      prompt_template: "处理 {{item}}",
      items: ["a", "a"],
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("重复");
    expect(calls).toHaveLength(0);
  });

  it("未接线 swarm 服务明确报错", async () => {
    const ctx: ToolContext = { agentId: "a1", workspaceDir: ".", approve: async () => true, services: {} };
    const result = await dispatchSubagentBatchTool.execute(ctx, {
      prompt_template: "处理 {{item}}",
      items: ["a", "b"],
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not available");
  });
});

describe("② XML 原位聚合", () => {
  it("合法调用：占位符展开传参正确，结果渲染 <agent_swarm_result>", async () => {
    const { ctx, calls } = makeCtx();
    const result = await dispatchSubagentBatchTool.execute(ctx, {
      prompt_template: "审查 {{item}} 的回归风险",
      items: ["src/a.ts", "src/b.ts"],
    });
    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.agentId).toBe("a1");
    expect(calls[0]!.items.map((i) => i.prompt)).toEqual([
      "审查 src/a.ts 的回归风险",
      "审查 src/b.ts 的回归风险",
    ]);
    const xml = String(result.output);
    expect(xml).toContain("<agent_swarm_result>");
    expect(xml).toContain('<item index="0" status="completed" taskId="t0">done:src/a.ts</item>');
    expect(xml).toContain('<item index="1" status="completed" taskId="t1">done:src/b.ts</item>');
  });

  it("completed/failed 各归其位；失败项内容渲染 error；XML 特殊字符转义", async () => {
    const { ctx } = makeCtx([
      { index: 0, item: "x", status: "completed", output: "ok <tag> & \"quoted\"", taskId: "t0" },
      { index: 1, item: "y", status: "failed", error: "boom <here>", taskId: "t1" },
    ]);
    const result = await dispatchSubagentBatchTool.execute(ctx, {
      prompt_template: "处理 {{item}}",
      items: ["x", "y"],
    });
    expect(result.success).toBe(true); // 部分失败仍返回聚合结果
    expect(result.error).toContain("1/2 个 item 失败");
    const xml = String(result.output);
    expect(xml).toContain('<item index="0" status="completed" taskId="t0">ok &lt;tag&gt; &amp; "quoted"</item>');
    expect(xml).toContain('<item index="1" status="failed" taskId="t1">boom &lt;here&gt;</item>');
  });

  it("全部失败：success=false 但仍返回聚合 XML", async () => {
    const { ctx } = makeCtx([
      { index: 0, item: "x", status: "failed", error: "e0", taskId: "t0" },
      { index: 1, item: "y", status: "failed", error: "e1", taskId: "t1" },
    ]);
    const result = await dispatchSubagentBatchTool.execute(ctx, {
      prompt_template: "处理 {{item}}",
      items: ["x", "y"],
    });
    expect(result.success).toBe(false);
    expect(String(result.output)).toContain("<agent_swarm_result>");
  });

  it("工具本身 requiresApproval（批量派遣动作人工确认）", () => {
    expect(dispatchSubagentBatchTool.requiresApproval).toBe(true);
  });
});
