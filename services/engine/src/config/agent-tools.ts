import type { AgentConfig } from "@mindcloud/shared";

/**
 * agentConfig.tools 判空归一（P3-4，功能 review M5）：
 * agent.json 允许省略 tools（config 层不校验），bootstrap 装配 worker 时直接
 * `agentConfig.tools.includes(...)` 会 TypeError，该 agent 聊天功能完全不可用。
 *
 * 方案：缺失/非数组按空工具集处理并 warn——chat-only agent（只聊天不调工具）
 * 是合法形态，不应让配置省略变成全功能崩溃。空数组是显式配置，不 warn。
 */
export function resolveConfiguredTools(agentConfig: AgentConfig): string[] {
  if (Array.isArray(agentConfig.tools)) return agentConfig.tools;
  console.warn(
    `[agents] agent=${agentConfig.id} 未配置 tools 字段，按空工具集装配（chat-only）`,
  );
  return [];
}
