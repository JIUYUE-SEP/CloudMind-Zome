import type { Context } from "cordis";
import type { AgentConfig } from "@mindcloud/shared";
import { getBuiltinTools } from "../../tools/builtin/index.js";
import { McpClientManager } from "../../tools/mcp/index.js";
import { qualifyExternalToolName } from "../../tools/external/naming.js";
import { resolveConfiguredTools } from "../../config/agent-tools.js";
import { logger } from "../../logger.js";
import type { Tool } from "../../tools/types.js";

/**
 * tools 插件（P3）：工具注册表面 ctx.tools 上架（内置清单 + MCP 工具合并入口），
 * worker/puppet 创建链的工具装配改经本面取（forAgent）。
 *
 * MCP 生命周期收编：loadDefault 读 DATA_DIR/mcp-servers.json 语义不变；
 * connectAll 在本 apply 内完成（async apply 由 fiber 激活等待，await
 * ctx.plugin(toolsPlugin) 保持原 bootstrap.ts:130-131 的"listen 前连完"时序）；
 * manager.close() 挂 fiber effect disposer——可逆注册纪律首个真实用例，
 * 关停钩 dispose 本插件 fiber 时执行。
 * ToolServices 的实例装配本期仍在 bootstrap（subagent/intermind/recall 等
 * P4–P7 才插件化），不属于本面上架范围。
 *
 * E3 外部工具注册：registerExternal 供 external 插件（bootstrap 最后挂载，
 * apply 时本面早已上架，时序天然安全）给 agent 注册新工具——命名规范化
 * ext__<plugin>__<tool>（tools/external/naming.ts，与 mcp__ 同套加固），
 * 冲突跳过、审批从严缺省；外部工具纳入 forAgent 白名单过滤（与内置同管线，
 * MCP 的「不参与白名单过滤」是 MCP 特例，外部工具不走特例）。
 */
export const name = "tools";

/** 无 ctx 服务依赖 */
export const inject: string[] = [];

/** ctx.tools 上架面 */
export interface ToolsRegistry {
  /** MCP 管理器（ApiContext 透传用；生命周期归本插件，见头注） */
  manager: McpClientManager;
  /** 内置工具全量清单 */
  getBuiltin(): Tool[];
  /** MCP 工具（动态命名 mcp__ 前缀，不参与 agent 白名单过滤） */
  getMcp(): Tool[];
  /** 外部插件注册的工具（E3：动态命名 ext__ 前缀，参与 agent 白名单过滤） */
  getExternal(): Tool[];
  /**
   * 外部插件给 agent 注册新工具（E3）：命名规范化 ext__<plugin>__<tool>；
   * 与内置/MCP/已注册外部同名（含 sanitize 后撞车）→ warn + 跳过返回 false，成功 true。
   * 审批从严缺省：requiresApproval === undefined 按 true 登记；插件可显式标 false
   * 声明只读——这是插件作者的自声明，信任模型同 external 插件头注（用户自装代码，
   * 进程内全权限，类 Obsidian）。
   */
  registerExternal(pluginName: string, tool: Tool): boolean;
  /** agent 工具装配：白名单 filter（内置 + 外部）+ MCP 合并（worker/puppet 创建链同一份快照语义） */
  forAgent(agentConfig: AgentConfig): Tool[];
}

declare module "cordis" {
  interface Context {
    /** 工具注册表面（见 ToolsRegistry） */
    tools: ToolsRegistry;
  }
}

export async function apply(ctx: Context): Promise<void> {
  const manager = McpClientManager.loadDefault();
  await manager.connectAll();
  // E3：外部插件工具注册表（本 fiber 闭包内，registerExternal 就地填充，
  // 随插件 fiber 生灭；无热重载——external 骨架同样重启生效，语义一致）
  const externalTools: Tool[] = [];
  const externalNames = new Set<string>();
  ctx.provide("tools", {
    manager,
    getBuiltin: getBuiltinTools,
    getMcp: () => manager.getTools(),
    getExternal: () => [...externalTools],
    registerExternal: (pluginName, tool) => {
      const qualified = qualifyExternalToolName(pluginName, tool.name);
      // 冲突检测：内置名 / MCP 名 / 已注册外部名（含 sanitize 后撞车）。
      // ext__ 前缀使内置/MCP 撞名实际不可达，留查作纵深防御；MCP 工具集在
      // 本 apply 的 connectAll 后已稳定（external 插件 bootstrap 最后挂载）
      const conflict =
        externalNames.has(qualified) ||
        getBuiltinTools().some((t) => t.name === qualified) ||
        manager.getTools().some((t) => t.name === qualified);
      if (conflict) {
        logger.warn(
          `[tools] 外部插件 ${pluginName} 注册工具 ${tool.name}（限定名 ${qualified}）与既有工具同名，跳过`,
        );
        return false;
      }
      // 审批从严缺省：requiresApproval 缺省按 true 登记（Tool 契约里 undefined
      // 等于免审批，必须收编）；插件可显式标 false 声明只读（插件作者自声明，
      // 信任模型见面上 JSDoc）。工具名改写为限定名，其余字段原样保留
      externalNames.add(qualified);
      externalTools.push({ ...tool, name: qualified, requiresApproval: tool.requiresApproval ?? true });
      return true;
    },
    forAgent: (agentConfig) => {
      // 白名单一次解析两处共用（顺带消除原先逐元素重复解析的重复 warn）
      const configured = resolveConfiguredTools(agentConfig);
      return [
        ...getBuiltinTools().filter((t) => configured.includes(t.name)),
        // 外部工具（ext__ 前缀）与内置同管线：白名单含限定名才启用，不写不启用
        ...externalTools.filter((t) => configured.includes(t.name)),
        // MCP 工具动态命名（mcp__ 前缀），不参与 agent 配置白名单过滤，与内置工具同管线
        ...manager.getTools(),
      ];
    },
  } satisfies ToolsRegistry);
  // close 挂 fiber effect：插件 fiber 被 dispose 时执行（bootstrap 关停钩触发）
  ctx.effect(() => async () => {
    await manager.close();
  });
}
