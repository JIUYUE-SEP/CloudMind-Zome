import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../types.js";
import { MAX_FOREGROUND_TIMEOUT_MS } from "../../subagent/dispatcher.js";

const parameters = z.object({
  agentId: z
    .string()
    .optional()
    .describe("要借用的目标 Agent id（kind=delegate 时必填；kind=puppet 时忽略、可缺省——傀儡是调用方自己的分身）"),
  task: z.string().describe("交给子 Agent 执行的任务描述"),
  mode: z.enum(["foreground", "background"]).default("foreground"),
  timeoutMs: z.number().int().positive().optional(),
  kind: z
    .enum(["puppet", "delegate"])
    .optional()
    .describe("子 Agent 分型：delegate=借用人形（默认）；puppet=傀儡（自己的一次性分身，无人格无记忆）"),
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
    "结果写入后台任务记录（你无法自助查询，用户可查看）。不能借用自己。" +
    "kind=puppet 时派遣傀儡而非借用：傀儡是你的一次性分身——无人格无记忆、记忆即弃，" +
    "用你的模型与工具裸跑（写类操作：前台模式桥接回当前会话审批，后台模式无审批通道一律拒绝），适合批量/重型中间过程；" +
    "同类批量任务建议等后续 swarm 能力，勿循环串行派遣。",
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

    const kind = parsed.kind ?? "delegate";
    if (kind !== "puppet" && !parsed.agentId) {
      return { success: false, error: "agentId 缺失：kind=delegate 必须指定借用目标（puppet 模式可缺省）" };
    }

    try {
      const result = await dispatcher.dispatch(ctx.agentId, parsed.agentId ?? ctx.agentId, parsed.task, {
        mode: parsed.mode,
        timeoutMs,
        kind,
        // puppet 前台的审批桥接：傀儡的写类工具回 owner 发起会话的审批通道
        approve: ctx.approve,
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
