import { z } from "zod";
import { MAX_FOREGROUND_TIMEOUT_MS } from "@cloudmind/shared";
import type { Tool, ToolContext, ToolResult } from "../types.js";
import type { SwarmItemResult } from "../../subagent/batch.js";

/** swarm 批量上限（桌面场景；kimi 128 调小） */
export const SWARM_MAX_ITEMS = 16;

const ITEM_PLACEHOLDER = "{{item}}";

const parameters = z.object({
  prompt_template: z.string().describe(`任务简报模板，必须恰好包含占位符 ${ITEM_PLACEHOLDER}（每个 item 展开为一条独立简报）`),
  items: z.array(z.string()).describe("批量输入项（2-16 个；展开后的简报必须互异）"),
  timeoutMs: z.number().int().positive().optional().describe("单个傀儡的超时（默认 120s）"),
});

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 按下标原位聚合渲染（completed/failed 各归其位），一次性返回 */
function renderSwarmResult(results: SwarmItemResult[]): string {
  const lines = results.map((r) => {
    const body =
      r.status === "completed"
        ? escapeXml(r.output ?? "")
        : escapeXml(r.error ?? r.status);
    const taskId = r.taskId ? ` taskId="${r.taskId}"` : "";
    return `<item index="${r.index}" status="${r.status}"${taskId}>${body}</item>`;
  });
  return `<agent_swarm_result>\n${lines.join("\n")}\n</agent_swarm_result>`;
}

export const dispatchSubagentBatchTool: Tool = {
  name: "dispatch_subagent_batch",
  description:
    "批量派遣傀儡 swarm：一个简报模板 × 多个 item，并行执行后一次性返回全部结果。" +
    "成员全部是傀儡（你的一次性分身，无人格无记忆），执行互不干扰也不污染任何 Agent 的记忆。" +
    `用法：prompt_template 中的占位符严格为 ${ITEM_PLACEHOLDER}，items 每个元素展开为一条独立简报；` +
    "少量形态各异的任务请改用多次 dispatch_subagent。" +
    "硬校验（任一不满足直接拒绝，不启动任何傀儡）：items 至少 2 个；" +
    `模板必须含 ${ITEM_PLACEHOLDER}；展开后的简报必须互异；items 至多 ${SWARM_MAX_ITEMS} 个。` +
    "swarm 内傀儡没有审批通道：写类工具一律被拒（fail-closed）——swarm 面向只读/分析/汇总类批量任务；" +
    "需要写操作的任务请用 dispatch_subagent 单独派遣。" +
    "批次纪律：一次响应只发一批（工具本就顺序执行）；结果按下标原位聚合（成功/失败各归其位）。" +
    "结果包含每个 item 的状态与结论；失败项可换 dispatch_subagent 单独补跑。",
  parameters,
  accesses: [],
  // 与 dispatch_subagent 同级：批量派遣动作必须人工确认（内部傀儡无审批通道）
  requiresApproval: true,
  // P3 看护：swarm 内各 item 并行，总时长接近单个上限而非累加，取同一硬上限
  timeoutMs: MAX_FOREGROUND_TIMEOUT_MS,
  async execute(ctx: ToolContext, args: unknown): Promise<ToolResult> {
    const swarm = ctx.services?.subagentSwarm;
    if (!swarm) {
      return { success: false, error: "Subagent swarm not available" };
    }

    let parsed: z.infer<typeof parameters>;
    try {
      parsed = parameters.parse(args);
    } catch (err) {
      return { success: false, error: String(err) };
    }

    // 硬校验前置：任何一条不满足直接拒绝，不启动任何傀儡
    if (!parsed.prompt_template.includes(ITEM_PLACEHOLDER)) {
      return { success: false, error: `prompt_template 必须包含占位符 ${ITEM_PLACEHOLDER}` };
    }
    if (parsed.items.length < 2) {
      return { success: false, error: "items 至少需要 2 个（单个任务请用 dispatch_subagent）" };
    }
    if (parsed.items.length > SWARM_MAX_ITEMS) {
      return { success: false, error: `items 至多 ${SWARM_MAX_ITEMS} 个（收到 ${parsed.items.length} 个）` };
    }
    const prompts = parsed.items.map((item) => parsed.prompt_template.split(ITEM_PLACEHOLDER).join(item));
    if (new Set(prompts).size !== prompts.length) {
      return { success: false, error: "展开后的简报存在重复（两个 item 展开为相同 prompt），已拒绝" };
    }

    try {
      const results = await swarm.run(
        ctx.agentId,
        parsed.items.map((item, index) => ({ prompt: prompts[index]!, item })),
        { timeoutMs: parsed.timeoutMs },
      );
      const failed = results.filter((r) => r.status !== "completed").length;
      return {
        success: failed < results.length,
        output: renderSwarmResult(results),
        ...(failed > 0 ? { error: `${failed}/${results.length} 个 item 失败（详见聚合结果）` } : {}),
      };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  },
};
