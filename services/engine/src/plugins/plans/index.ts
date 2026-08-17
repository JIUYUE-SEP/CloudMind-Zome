import type { Context } from "cordis";
import { PlanManager } from "../../plan/manager.js";
import { PlanRepository } from "../../plan/repository.js";

/**
 * plans 插件（P7c）：per-agent PlanManager 懒创建收编上架 ctx.plans。
 *
 * - getPlanManager 本体自 bootstrap.ts 迁入，语义逐字保留：agentRepository.get
 *   判存在（agent 不存在返回 undefined）→ `new PlanManager({ provider, model },
 *   new PlanRepository(agentId))` → manager.load() 恢复 plans.jsonl（running
 *   步骤回退 pending）→ Map 缓存；模型回落链 `modelId || model || "gpt-4o"`。
 * - agentRepository 来自 agents 面合体单例（即 ctx.memory 同一实例），
 *   createProvider 来自 llm 面工厂；PlanRepository 库级直 new 口径不变
 *   （同 P4 document-store 先例——不进插件面）。
 */
export const name = "plans";

/** agentRepository 来自 agents 面；createProvider 来自 llm 面（见头注） */
export const inject = ["agents", "llm"];

/** ctx.plans 上架面 */
export interface PlansFace {
  /** 按 agent 维度获取（懒创建）PlanManager；agent 不存在时返回 undefined */
  getPlanManager(agentId: string): Promise<PlanManager | undefined>;
}

declare module "cordis" {
  interface Context {
    /** per-agent 计划管理面（见 PlansFace） */
    plans: PlansFace;
  }
}

export function apply(ctx: Context): void {
  const planManagers = new Map<string, PlanManager>();
  async function getPlanManager(agentId: string): Promise<PlanManager | undefined> {
    const existing = planManagers.get(agentId);
    if (existing) return existing;
    const agentConfig = await ctx.agents.agentRepository.get(agentId);
    if (!agentConfig) return undefined;
    const manager = new PlanManager(
      {
        provider: await ctx.llm.createProvider(agentConfig),
        model: agentConfig.modelId || agentConfig.model || "gpt-4o",
      },
      new PlanRepository(agentId),
    );
    // 从 plans.jsonl 恢复历史 plan（running 步骤回退 pending，见 PlanManager.load）
    await manager.load();
    planManagers.set(agentId, manager);
    return manager;
  }
  ctx.provide("plans", { getPlanManager } satisfies PlansFace);
}
