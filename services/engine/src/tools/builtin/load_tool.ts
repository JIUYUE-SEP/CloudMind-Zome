import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Tool, ToolContext, ToolResult } from "../types.js";

const NAMES_MAX = 8;

const parameters = z.object({
  names: z
    .array(z.string().min(1))
    .min(1)
    .max(NAMES_MAX)
    .describe(`要取回的动态工具限定名（来自 L1「按需工具」目录，mcp__…/ext__…），单次 ≤${NAMES_MAX}`),
});

/**
 * load_tool（第 15 件内置，core 常驻；spec 决策 3/5）：
 * 按需工具目录的取回入口——目录中的动态工具（mcp__/ext__）须先经本工具
 * 取回拿到完整 schema，后续步骤才能调用。免审批（元数据只读，同 skill 档）；
 * 被取回工具自身 requiresApproval 不变，实调照走既有审批链。
 * fail-closed（spec 4.3）：未知名 → 错误 + 可用名录；内置名 → 「已常驻无需
 * 取回」；任一非法整体不写 loaded set（原子）。
 */
export const loadTool: Tool = {
  name: "load_tool",
  description:
    "Load dynamic tools (mcp__*/ext__* names from the on-demand tool catalog) by qualified name: " +
    "returns each tool's full description and parameters JSON schema, and injects them into the " +
    "tool list of subsequent steps in this session (LRU cap 16). Unknown or already-resident " +
    "builtin names are rejected with guidance; no approval required.",
  parameters,
  accesses: [{ resource: "memory", action: "read" }],
  requiresApproval: false,
  async execute(ctx: ToolContext, args: unknown): Promise<ToolResult> {
    let parsed: z.infer<typeof parameters>;
    try {
      parsed = parameters.parse(args);
    } catch (err) {
      return { success: false, error: String(err) };
    }

    const loader = ctx.services?.dynamicToolLoader;
    if (!loader || loader.dynamicCount === 0) {
      return {
        success: false,
        error: "load_tool 无可用动态工具（本 agent 未挂 MCP / 外部插件工具）",
      };
    }

    const c = loader.classify(parsed.names);
    if (c.unknown.length > 0) {
      const available = loader.availableNames();
      return {
        success: false,
        error:
          `load_tool 未知工具：${c.unknown.join("、")}。` +
          `可用动态工具：${available.length > 0 ? available.join("、") : "（无）"}`,
      };
    }
    if (c.builtin.length > 0) {
      return {
        success: false,
        error: `load_tool 以下工具已常驻，无需取回：${c.builtin.join("、")}`,
      };
    }

    // 分类全合法，load 必提交（原子语义见 loader）
    loader.load(parsed.names);
    const tools = [...c.fresh, ...c.repeat].map((t) => ({
      name: t.name,
      description: t.description,
      parameters: zodToJsonSchema(t.parameters),
    }));
    return {
      success: true,
      output: {
        tools,
        note: "已取回并注入：后续步骤可直接调用（各工具自身审批规则不变）",
      },
    };
  },
};
