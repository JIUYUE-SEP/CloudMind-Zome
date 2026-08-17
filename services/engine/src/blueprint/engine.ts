import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import { logger } from "../logger.js";
import type { ApiContext } from "../api/context.js";
import { getBuiltinTools } from "../tools/builtin/index.js";
import { getDataDir } from "../config/paths.js";
import type { Blueprint, BlueprintExecution, BlueprintNode } from "./types.js";
import type { LLMEvent } from "../provider/types.js";
import type { ToolServices } from "../tools/types.js";

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
    // M25：执行前结构校验——悬空边/分支边此前被 getNextNode 静默截断，
    // 现在明确报错不执行（status=failed，原因写入 logs）
    validateBlueprint(blueprint);

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
    // M25：本次执行的工具工作区（blueprint-workspace/<executionId>）用后即焚；
    // 清理失败只记 warn，不炸主流程（执行结果已定型）
    try {
      await fs.rm(path.join(getDataDir(), "blueprint-workspace", execution.id), {
        recursive: true,
        force: true,
      });
    } catch (err) {
      logger.warn({ err, executionId: execution.id }, "blueprint workspace cleanup failed");
    }
  }

  return execution;
}

/**
 * M25 结构校验：本引擎只支持线性链（getNextNode 只取首条出边），
 * 因此悬空边（source/target 指向不存在节点）与分支边（同一 source 多条出边）
 * 都视为非法蓝图，直接抛错而不是静默丢弃。
 */
function validateBlueprint(blueprint: Blueprint): void {
  const nodeIds = new Set(blueprint.nodes.map((n) => n.id));
  const sources = new Set<string>();
  for (const edge of blueprint.edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      throw new Error(
        `blueprint edge ${edge.source} -> ${edge.target} references a missing node`
      );
    }
    if (sources.has(edge.source)) {
      throw new Error(
        `blueprint node ${edge.source} has multiple outgoing edges (branching is not supported)`
      );
    }
    sources.add(edge.source);
  }
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
    // P1-6 补修：ReAct 每步都发 step.end——首步发起工具调用时若在首个
    // step.end 就 resolve，会拿首步文本（通常空）返回 "(empty)" 让 turn
    // 后台白跑。语义核对（core/react/turn.ts + agent-worker 事件序列）：
    // 工具步 = tool.call/tool.result + step.end；收尾步 = 纯文本 + step.end
    // （含 maxSteps/水位兜底的无工具总结）；turn.end 在整轮结束后发出。
    // 因此只在本步无 tool.call 的 step.end（收尾步）resolve，turn.end 作
    // 异常/极端事件序的兜底；中间工具步清空步文本继续等。
    let stepText = "";
    let fullText = "";
    let stepHasToolCall = false;
    let finished = false;
    // M26：超时通道——resolve 占位文本的同时中止在途/排队 job，否则蓝图已
    // 拿 "(timeout)" 走人，orphan 回合仍在后台烧 token。signal 语义对齐
    // agent-worker：排队 job 直接跳过，运行中 job 在步骤边界中止。
    const abort = new AbortController();
    const timeout = setTimeout(() => {
      if (!finished) {
        finished = true;
        abort.abort();
        execution.logs.push(`llm node ${node.id} timed out after ${LLM_TIMEOUT_MS}ms, job aborted`);
        resolve(stepText || fullText || "(timeout)");
      }
    }, LLM_TIMEOUT_MS);

    const onEvent = (event: LLMEvent) => {
      if (finished) return;
      if (event.type === "text.delta") {
        stepText += event.delta;
        fullText += event.delta;
      } else if (event.type === "tool.call") {
        stepHasToolCall = true;
      } else if (event.type === "step.end") {
        if (!stepHasToolCall) {
          // 收尾步：无工具调用的最终文本步
          finished = true;
          clearTimeout(timeout);
          resolve(stepText || "(empty)");
        } else {
          // 中间工具步：不 resolve，清步缓存等下一轮
          stepHasToolCall = false;
          stepText = "";
        }
      } else if (event.type === "turn.end") {
        // 兜底（异常/事件序极端）：本轮生成终止即收尾
        finished = true;
        clearTimeout(timeout);
        resolve(fullText || "(empty)");
      }
    };

    worker.enqueue({
      id: randomUUID(),
      // P1-6 补修：蓝图 job 用独立命名空间 sessionId（subagent 同范式），
      // 不回落 sessionId=agentId——主会话热存储/话题源不被蓝图流量顶替
      sessionId: `blueprint:${execution.id}`,
      // 蓝图是非人形工作流：瞬态回合不落 agent 热存储、不进话题 tracker/
      // 压缩/向量索引（worker 侧 ephemeral 标记，人格历史零污染）
      ephemeral: true,
      messages: [message],
      // M26：超时中止通道（见上方 timeout）
      signal: abort.signal,
      onEvent,
    });
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
  const result = await executeTool(toolName, args, execution.id, {
    subagentDispatcher: context.subagentDispatcher,
  });
  execution.logs.push(`executed tool node ${node.id}`);
  return result;
}

function getNextNode(nodeId: string, blueprint: Blueprint): BlueprintNode | undefined {
  const edge = blueprint.edges.find((e) => e.source === nodeId);
  if (!edge) return undefined;
  return blueprint.nodes.find((n) => n.id === edge.target);
}

async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  executionId: string,
  services?: ToolServices,
): Promise<unknown> {
  const tools = getBuiltinTools();
  const tool = tools.find((t) => t.name === toolName);
  if (!tool) return `tool not found: ${toolName}`;
  // blueprint 没有人工审批通道，requiresApproval 工具一律拒绝执行
  // （types.ts 契约：无审批通道的调用一律拒绝），防止审批门被 executeTool 旁路
  if (tool.requiresApproval) {
    return `tool requires approval and cannot run in blueprints: ${toolName}`;
  }
  // Intermind 私信是「她和她」之间的事：蓝图不是人形，无社交权——显式拒绝，
  // 不依赖 services 缺注入的偶然结果
  if (toolName === "send_private_message") {
    return "send_private_message 不能在蓝图工作流中执行：蓝图不是人形，无社交权";
  }
  const workspaceDir = path.join(getDataDir(), "blueprint-workspace", executionId);
  await fs.mkdir(workspaceDir, { recursive: true });
  try {
    const toolCtx = {
      agentId: "blueprint",
      workspaceDir,
      approve: () => true,
      services,
    };
    const result = await tool.execute(toolCtx, args);
    return result.success ? result.output : `tool error: ${result.error || "unknown"}`;
  } catch (err) {
    return `tool error: ${String(err)}`;
  }
}
