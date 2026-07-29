import { randomUUID } from "node:crypto";
import type { LLMProvider } from "../provider/types.js";
import type { PlanRepository } from "./repository.js";
import type { Plan, PlanStep, PlanStepType } from "./types.js";

// step.output 落盘体积上限：超过即截断并加标记后缀，防止 plans.jsonl 无限膨胀
const MAX_OUTPUT_SERIALIZED_BYTES = 50 * 1024;
const TRUNCATED_SUFFIX = "...[truncated]";
// 重启恢复策略：中断时处于 running 的 step 回退 pending 时写入的中断说明
const INTERRUPTED_ERROR = "interrupted: engine restarted";

export interface PlanManagerOptions {
  provider: LLMProvider;
  model: string;
}

export class PlanManager {
  private plans = new Map<string, Plan>();

  constructor(
    private options: PlanManagerOptions,
    private repository?: PlanRepository,
  ) {}

  /**
   * 从 plans.jsonl 恢复内存 Map（重启恢复）。
   * 恢复策略：中断时处于 running 的 step 一律回退为 pending 并在 error 写入
   * 中断说明，plan 的 running 同样回退为 pending——/run 只执行 pending 步骤，
   * running 原样恢复会让 plan 永久卡死。
   */
  async load(): Promise<void> {
    if (!this.repository) return;
    const persisted = await this.repository.loadAll();
    for (const plan of persisted) {
      for (const step of plan.steps) {
        if (step.status === "running") {
          step.status = "pending";
          step.error = INTERRUPTED_ERROR;
        }
      }
      if (plan.status === "running") plan.status = "pending";
      this.plans.set(plan.id, plan);
    }
  }

  /** 状态变更后落盘；step.output 序列化超上限时截断（仅影响落盘副本，不动内存态） */
  private async persist(plan: Plan): Promise<void> {
    if (!this.repository) return;
    const snapshot = structuredClone(plan);
    for (const step of snapshot.steps) {
      if (step.output === undefined) continue;
      const serialized = JSON.stringify(step.output);
      if (serialized.length > MAX_OUTPUT_SERIALIZED_BYTES) {
        step.output = serialized.slice(0, MAX_OUTPUT_SERIALIZED_BYTES) + TRUNCATED_SUFFIX;
      }
    }
    await this.repository.upsert(snapshot);
  }

  async createPlan(goal: string): Promise<Plan> {
    const steps = await this.generateSteps(goal);
    const plan: Plan = {
      id: randomUUID(),
      goal,
      steps,
      status: "pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.plans.set(plan.id, plan);
    await this.persist(plan);
    return plan;
  }

  private async generateSteps(goal: string): Promise<PlanStep[]> {
    // Phase 5 uses a simple heuristic parser; later phases can call LLM.
    const steps: PlanStep[] = [];
    const lines = goal.split("\n").filter((l) => l.trim());
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith("- ") || /^\d+\./.test(line)) {
        const desc = line.replace(/^- /, "").replace(/^\d+\.\s*/, "");
        steps.push(this.makeStep(`step_${i}`, desc, "llm"));
      }
    }
    if (steps.length === 0) {
      steps.push(this.makeStep("step_0", goal, "llm"));
    }
    return steps;
  }

  private makeStep(id: string, description: string, type: PlanStepType): PlanStep {
    return { id, description, type, status: "pending" };
  }

  get(planId: string): Plan | undefined {
    return this.plans.get(planId);
  }

  list(): Plan[] {
    return Array.from(this.plans.values());
  }

  async executeStep(planId: string, stepId: string, executor: (step: PlanStep) => Promise<unknown>): Promise<Plan> {
    const plan = this.plans.get(planId);
    if (!plan) throw new Error(`Plan ${planId} not found`);
    const step = plan.steps.find((s) => s.id === stepId);
    if (!step) throw new Error(`Step ${stepId} not found`);

    if (plan.status === "paused") return plan;

    step.status = "running";
    step.error = undefined;
    plan.status = "running";
    plan.updatedAt = new Date().toISOString();
    // running 也落盘：重启恢复依赖磁盘上的 running 标记识别中断步骤
    await this.persist(plan);

    try {
      const output = await executor(step);
      step.output = output;
      step.status = "completed";
    } catch (err) {
      step.error = String(err);
      step.status = "failed";
      plan.status = "failed";
    }

    if (plan.status !== "failed" && plan.steps.every((s) => s.status === "completed")) {
      plan.status = "completed";
    }

    plan.updatedAt = new Date().toISOString();
    await this.persist(plan);
    return plan;
  }

  async pause(planId: string): Promise<Plan> {
    const plan = this.plans.get(planId);
    if (!plan) throw new Error(`Plan ${planId} not found`);
    plan.status = "paused";
    plan.updatedAt = new Date().toISOString();
    await this.persist(plan);
    return plan;
  }

  async resume(planId: string): Promise<Plan> {
    const plan = this.plans.get(planId);
    if (!plan) throw new Error(`Plan ${planId} not found`);
    plan.status = plan.steps.some((s) => s.status === "running") ? "running" : "pending";
    plan.updatedAt = new Date().toISOString();
    await this.persist(plan);
    return plan;
  }

  async retry(planId: string, stepId: string): Promise<Plan> {
    const plan = this.plans.get(planId);
    if (!plan) throw new Error(`Plan ${planId} not found`);
    const step = plan.steps.find((s) => s.id === stepId);
    if (!step) throw new Error(`Step ${stepId} not found`);
    step.status = "pending";
    step.error = undefined;
    step.output = undefined;
    plan.status = plan.status === "failed" ? "pending" : plan.status;
    plan.updatedAt = new Date().toISOString();
    await this.persist(plan);
    return plan;
  }
}
