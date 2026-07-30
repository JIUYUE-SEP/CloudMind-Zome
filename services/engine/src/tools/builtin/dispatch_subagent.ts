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
    "借用另一个 Agent 执行子任务。子 Agent 零上下文启动、在自己的上下文中独立运行。" +
    "委派纪律：① 像给刚进门的同事简报——说清目标、列出你已知的、移交具体信息；" +
    "② 查找类任务（读某文件、跑某命令）在任务里给确切路径/命令，别让子 Agent 找你已知的东西；" +
    "③ 调查类任务（弄清 X、找出 Y 的原因）给问题本身，不给预设步骤——前提错了步骤就是死重；" +
    "④ 不委派理解——任务成败系于某个文件/行号时，自己先找到再写进任务。" +
    "反委派纪律：⑤ 琐事不委派（已知路径的读取、小范围搜索、一两步能做完的事）——委派有上下文交接成本，任务不够重就不值；" +
    "⑥ 子 Agent 运行中不并行重做它的搜索/读取，不中途抛弃它手动收尾（两者都会抵消委派省下的上下文）；" +
    "⑦ 子 Agent 的结果只对调用者可见——用户需要看到时，由你在自己的回复里转述要点。" +
    "foreground 模式等待并返回子 Agent 的最终文本；background 模式立即返回 taskId，" +
    "结果写入后台任务记录（你无法自助查询，用户可查看）。不能借用自己。",
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
