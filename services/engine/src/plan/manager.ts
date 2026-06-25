import { randomUUID } from "node:crypto";
import type { LLMProvider } from "../provider/types.js";
import type { Plan, PlanStep, PlanStepType } from "./types.js";

export interface PlanManagerOptions {
  provider: LLMProvider;
  model: string;
}

export class PlanManager {
  private plans = new Map<string, Plan>();

  constructor(private options: PlanManagerOptions) {}

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
    plan.status = "running";
    plan.updatedAt = new Date().toISOString();

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
    return plan;
  }

  pause(planId: string): Plan {
    const plan = this.plans.get(planId);
    if (!plan) throw new Error(`Plan ${planId} not found`);
    plan.status = "paused";
    plan.updatedAt = new Date().toISOString();
    return plan;
  }

  resume(planId: string): Plan {
    const plan = this.plans.get(planId);
    if (!plan) throw new Error(`Plan ${planId} not found`);
    plan.status = plan.steps.some((s) => s.status === "running") ? "running" : "pending";
    plan.updatedAt = new Date().toISOString();
    return plan;
  }

  retry(planId: string, stepId: string): Plan {
    const plan = this.plans.get(planId);
    if (!plan) throw new Error(`Plan ${planId} not found`);
    const step = plan.steps.find((s) => s.id === stepId);
    if (!step) throw new Error(`Step ${stepId} not found`);
    step.status = "pending";
    step.error = undefined;
    step.output = undefined;
    plan.status = plan.status === "failed" ? "pending" : plan.status;
    plan.updatedAt = new Date().toISOString();
    return plan;
  }
}
