import path from "node:path";
import { DocumentStore } from "../memory/document-store.js";
import { getAgentDir, sanitizeAgentId } from "../config/paths.js";
import type { Plan } from "./types.js";

/**
 * Plan 持久化（plans.jsonl，per-agent）：模式与 SchedulerRepository 一致，
 * 原子写 / Windows EPERM 重试 / 写队列串行均由 DocumentStore 内建。
 */
export class PlanRepository {
  private store: DocumentStore<Plan>;

  constructor(agentId: string) {
    sanitizeAgentId(agentId);
    this.store = new DocumentStore<Plan>(path.join(getAgentDir(agentId), "plans.jsonl"));
  }

  async loadAll(): Promise<Plan[]> {
    return this.store.readLines();
  }

  /** 按 id 更新已有记录；不存在则追加 */
  async upsert(plan: Plan): Promise<void> {
    await this.store.mutateLines((plans) => {
      const index = plans.findIndex((p) => p.id === plan.id);
      if (index === -1) return [...plans, plan];
      plans[index] = plan;
      return plans;
    });
  }
}
