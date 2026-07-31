import { z } from "zod";
import { logger } from "../../logger.js";
import type { Tool, ToolContext, ToolResult } from "../types.js";

const parameters = z.object({
  name: z.string().min(1).describe("技能名（L1 目录中列出的名字）"),
});

/** 调用记录（阶段 5 二期 promptHistory）：落盘失败只记 warn，不炸工具返回 */
async function recordUsage(ctx: ToolContext, name: string, ok: boolean, error?: string): Promise<void> {
  try {
    await ctx.services?.skillService?.recordUsage(ctx.agentId, { name, ok, error });
  } catch (err) {
    logger.warn({ err: err }, `[skill] 调用记录落盘失败（已跳过）：${name}`);
  }
}

/**
 * Skill 工具（阶段 5 一期，技能工具化）：
 * L1 目录管发现（有什么技能），本工具管取规程正文（SKILL.md 全文原样）。
 * fail-closed：技能不存在返回明确错误 + 可用技能名列表，不许模型瞎编规程。
 */
export const skillTool: Tool = {
  name: "skill",
  description:
    "按名取技能规程正文（SKILL.md 全文）。分工：L1 的技能目录管浏览有什么技能，" +
    "本工具管取规程正文——任务与目录中某技能的描述/适用场景匹配时，先调本工具取规程，" +
    "再按规程执行；未取到规程不得假装按规程执行。技能不存在时返回可用技能名列表。",
  parameters,
  // 读技能正文只读无危害，免审批；资源如实标注（技能文件读）
  accesses: [{ resource: "file", action: "read" }],
  requiresApproval: false,
  async execute(ctx: ToolContext, args: unknown): Promise<ToolResult> {
    const skillService = ctx.services?.skillService;
    if (!skillService) {
      return { success: false, error: "Skill service not available" };
    }

    let parsed: z.infer<typeof parameters>;
    try {
      parsed = parameters.parse(args);
    } catch (err) {
      return { success: false, error: String(err) };
    }

    try {
      const content = await skillService.getContent(ctx.agentId, parsed.name);
      if (content === undefined) {
        const available = (await skillService.list(ctx.agentId)).map((s) => s.name);
        const error = `技能「${parsed.name}」不存在。可用技能：${available.length > 0 ? available.join("、") : "（无）"}`;
        await recordUsage(ctx, parsed.name, false, "技能不存在");
        return { success: false, error };
      }
      // 正文原样返回（加载体系怎么读就怎么给，不二次加工）
      await recordUsage(ctx, parsed.name, true);
      return { success: true, output: content };
    } catch (err) {
      await recordUsage(ctx, parsed.name, false, String(err));
      return { success: false, error: String(err) };
    }
  },
};
