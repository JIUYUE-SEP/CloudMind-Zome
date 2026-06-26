import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import type { ApiContext } from "../api/context.js";
import { getBuiltinTools } from "../tools/builtin/index.js";
import { getDataDir } from "../config/paths.js";
import type { Blueprint, BlueprintExecution, BlueprintNode } from "./types.js";
import type { LLMEvent } from "../provider/types.js";

export interface ExecuteOptions {
  initialInput?: string;
}

const LLM_TIMEOUT_MS = 30000;

export async function executeBlueprint(
  blueprint: Blueprint,
  context: ApiContext,
  options: ExecuteOptions = {}
): Promise<BlueprintExecution> {
  const execution: BlueprintExecution = {
    id: randomUUID(),
    blueprintId: blueprint.id,
    status: "running",
    startedAt: new Date().toISOString(),
    outputs: {},
    logs: [],
  };

  try {
    const startNode = blueprint.nodes.find((n) => n.type === "start");
    if (!startNode) throw new Error("blueprint missing start node");

    const outputs: Record<string, unknown> = { [startNode.id]: options.initialInput || "" };
    execution.logs.push(`started at ${startNode.id}`);

    const visited = new Set<string>();
    await executeNode(startNode, blueprint, context, outputs, visited, execution);

    execution.outputs = outputs;
    execution.status = "completed";
  } catch (err) {
    execution.status = "failed";
    execution.logs.push(`error: ${String(err)}`);
  } finally {
    execution.completedAt = new Date().toISOString();
  }

  return execution;
}

async function executeNode(
  node: BlueprintNode,
  blueprint: Blueprint,
  context: ApiContext,
  outputs: Record<string, unknown>,
  visited: Set<string>,
  execution: BlueprintExecution
): Promise<void> {
  if (visited.has(node.id)) return;
  visited.add(node.id);

  const nextNode = getNextNode(node.id, blueprint);
  if (!nextNode) {
    execution.logs.push(`reached end at ${node.id}`);
    return;
  }

  const input = outputs[node.id];

  if (nextNode.type === "llm") {
    outputs[nextNode.id] = await executeLlmNode(nextNode, input, context, execution);
  } else if (nextNode.type === "tool") {
    outputs[nextNode.id] = await executeToolNode(nextNode, context, execution);
  } else if (nextNode.type === "end") {
    outputs[nextNode.id] = input || "";
    execution.logs.push(`reached end node ${nextNode.id}`);
  }

  await executeNode(nextNode, blueprint, context, outputs, visited, execution);
}

async function executeLlmNode(
  node: BlueprintNode,
  input: unknown,
  context: ApiContext,
  execution: BlueprintExecution
): Promise<unknown> {
  const agentId = String(node.config?.agentId || "");
  const prompt = String(node.config?.prompt || input || "");
  const worker = agentId ? await context.getAgentWorker(agentId) : undefined;
  if (!worker) {
    execution.logs.push(`executed llm node ${node.id}: no worker for agent ${agentId}`);
    return `no worker for agent ${agentId}`;
  }

  const message = {
    id: randomUUID(),
    role: "user" as const,
    content: [{ type: "text" as const, text: prompt }],
    createdAt: new Date().toISOString(),
  };

  const result = await new Promise<string>((resolve) => {
    let text = "";
    let finished = false;
    const timeout = setTimeout(() => {
      if (!finished) {
        finished = true;
        resolve(text || "(timeout)");
      }
    }, LLM_TIMEOUT_MS);

    const onEvent = (event: LLMEvent) => {
      if (finished) return;
      if (event.type === "text.delta") {
        text += event.delta;
      } else if (event.type === "step.end") {
        finished = true;
        clearTimeout(timeout);
        resolve(text || "(empty)");
      }
    };

    worker.enqueue({ id: randomUUID(), messages: [message], onEvent });
  });

  execution.logs.push(`executed llm node ${node.id}`);
  return result;
}

async function executeToolNode(
  node: BlueprintNode,
  context: ApiContext,
  execution: BlueprintExecution
): Promise<unknown> {
  const toolName = String(node.config?.toolName || "");
  const args = (node.config?.arguments as Record<string, unknown>) || {};
  const result = await executeTool(toolName, args);
  execution.logs.push(`executed tool node ${node.id}`);
  return result;
}

function getNextNode(nodeId: string, blueprint: Blueprint): BlueprintNode | undefined {
  const edge = blueprint.edges.find((e) => e.source === nodeId);
  if (!edge) return undefined;
  return blueprint.nodes.find((n) => n.id === edge.target);
}

async function executeTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
  const workspaceDir = path.join(getDataDir(), "blueprint-workspace");
  await fs.mkdir(workspaceDir, { recursive: true });
  const tools = getBuiltinTools();
  const tool = tools.find((t) => t.name === toolName);
  if (!tool) return `tool not found: ${toolName}`;
  try {
    const toolCtx = {
      agentId: "blueprint",
      workspaceDir,
      requiresApproval: () => false,
    };
    const result = await tool.execute(toolCtx, args);
    return result.success ? result.output : `tool error: ${result.error || "unknown"}`;
  } catch (err) {
    return `tool error: ${String(err)}`;
  }
}
