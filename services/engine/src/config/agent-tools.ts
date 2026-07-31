import { logger } from "../logger.js";
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
  if (Array.isArray(agentConfig.tools)) {
    // 落差可见（stage 5 review 建议）：配置了技能但白名单未授权 skill 工具时，
    // L1 目录在手而取正文的工具不在——功能静默失效（fail-closed 无安全风险），warn 提醒配置者
    if (agentConfig.skills.length > 0 && !agentConfig.tools.includes("skill")) {
      logger.warn(
        `[agents] agent=${agentConfig.id} 配置了 ${agentConfig.skills.length} 个技能但 tools 白名单不含 "skill"——技能目录可见但无法取规程正文，请在 agent.json 的 tools 中加入 "skill"`,
      );
    }
    return agentConfig.tools;
  }
  logger.warn(
    `[agents] agent=${agentConfig.id} 未配置 tools 字段，按空工具集装配（chat-only）`,
  );
  return [];
}
