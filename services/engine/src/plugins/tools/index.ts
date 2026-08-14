import type { Context } from "cordis";
import type { AgentConfig } from "@mindcloud/shared";
import { getBuiltinTools } from "../../tools/builtin/index.js";
import { McpClientManager } from "../../tools/mcp/index.js";
import { resolveConfiguredTools } from "../../config/agent-tools.js";
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
  /** agent 工具装配：白名单 filter + MCP 合并（worker/puppet 创建链同一份快照语义） */
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
  ctx.provide("tools", {
    manager,
    getBuiltin: getBuiltinTools,
    getMcp: () => manager.getTools(),
    forAgent: (agentConfig) => [
      ...getBuiltinTools().filter((t) => resolveConfiguredTools(agentConfig).includes(t.name)),
      // MCP 工具动态命名（mcp__ 前缀），不参与 agent 配置白名单过滤，与内置工具同管线
      ...manager.getTools(),
    ],
  } satisfies ToolsRegistry);
  // close 挂 fiber effect：插件 fiber 被 dispose 时执行（bootstrap 关停钩触发）
  ctx.effect(() => async () => {
    await manager.close();
  });
}
