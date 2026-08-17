export type PlanStepType = "tool" | "subagent" | "llm";

export interface PlanStep {
  id: string;
  description: string;
  type: PlanStepType;
  target?: string;
  input?: unknown;
  // aborted：断连/步骤硬超时等外部中止（区别于 failed——中断可恢复，/run 会重跑）
  status: "pending" | "running" | "completed" | "failed" | "aborted" | "awaiting_approval";
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
