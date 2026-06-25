export type PlanStepType = "tool" | "subagent" | "llm";

export interface PlanStep {
  id: string;
  description: string;
  type: PlanStepType;
  target?: string;
  input?: unknown;
  status: "pending" | "running" | "completed" | "failed" | "awaiting_approval";
  output?: unknown;
  error?: string;
}

export interface Plan {
  id: string;
  goal: string;
  steps: PlanStep[];
  status: "pending" | "running" | "paused" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
}
