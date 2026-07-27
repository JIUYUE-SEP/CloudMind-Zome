import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../types.js";
import { MAX_FOREGROUND_TIMEOUT_MS } from "../../subagent/dispatcher.js";

const parameters = z.object({
  agentId: z.string().describe("要借用的目标 Agent id"),
  task: z.string().describe("交给子 Agent 执行的任务描述"),
  mode: z.enum(["foreground", "background"]).default("foreground"),
  timeoutMs: z.number().int().positive().optional(),
});

export const dispatchSubagentTool: Tool = {
  name: "dispatch_subagent",
  description:
    "借用另一个 Agent 执行子任务。foreground 模式等待并返回子 Agent 的最终文本；" +
    "background 模式立即返回 taskId，稍后可通过后台任务查询获取结果。不能借用自己。",
  parameters,
  accesses: [],
  // P2-5（安全 review 注入 Major-6）：派生子 agent 是跨 agent confused
  // deputy 通道（任务原样成为子 agent 输入、结果原样回流），纳入审批——
  // 目标 agent 与任务内容必须人工确认；子 agent 侧无审批通道 fail-closed，
  // 嵌套派生随之被拒（纵深一致）
  requiresApproval: true,
  async execute(ctx: ToolContext, args: unknown): Promise<ToolResult> {
    const dispatcher = ctx.services?.subagentDispatcher;
    if (!dispatcher) {
      return { success: false, error: "Subagent dispatcher not available" };
    }

    let parsed: z.infer<typeof parameters>;
    try {
      parsed = parameters.parse(args);
    } catch (err) {
      return { success: false, error: String(err) };
    }

    // 前台模式超时上限 5 分钟，避免单个工具调用无限挂起
    const timeoutMs =
      parsed.mode === "foreground"
        ? Math.min(parsed.timeoutMs ?? 120_000, MAX_FOREGROUND_TIMEOUT_MS)
        : parsed.timeoutMs;

    try {
      const result = await dispatcher.dispatch(ctx.agentId, parsed.agentId, parsed.task, {
        mode: parsed.mode,
        timeoutMs,
      });
      if (typeof result === "string") {
        return { success: true, output: { taskId: result } };
      }
      if (result.error) {
        return { success: false, error: result.error, output: { taskId: result.taskId } };
      }
      return { success: true, output: { taskId: result.taskId, output: result.output } };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  },
};
