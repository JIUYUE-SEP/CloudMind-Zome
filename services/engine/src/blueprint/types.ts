export type BlueprintNodeType = "start" | "llm" | "tool" | "end";

export interface BlueprintNode {
  id: string;
  type: BlueprintNodeType;
  x: number;
  y: number;
  config?: Record<string, unknown>;
}

export interface BlueprintEdge {
  source: string;
  target: string;
}

export interface Blueprint {
  id: string;
  name: string;
  nodes: BlueprintNode[];
  edges: BlueprintEdge[];
  createdAt: string;
  updatedAt: string;
}

export interface BlueprintExecution {
  id: string;
  blueprintId: string;
  status: "pending" | "running" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
  outputs: Record<string, unknown>;
  logs: string[];
}
