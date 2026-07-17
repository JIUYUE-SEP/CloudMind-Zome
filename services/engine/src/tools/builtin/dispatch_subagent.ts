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
