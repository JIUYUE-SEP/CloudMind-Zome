import type { Tool, ToolContext } from "../../tools/types.js";
import type { LLMEvent } from "../../provider/types.js";
import { ToolScheduler } from "./tool-scheduler.js";

export interface ToolCallRequest {
  toolCallId: string;
  name: string;
  arguments: unknown;
}

export interface ToolCallResult {
  toolCallId: string;
  output: unknown;
}

export interface ToolExecutionContext {
  agentId: string;
  workspaceDir: string;
  projectRoot?: string;
  tools: Map<string, Tool>;
  approve: (toolName: string, args: unknown, toolCallId?: string) => boolean | Promise<boolean>;
  emit: (event: LLMEvent) => void;
  services?: ToolContext["services"];
}

export async function runToolCallBatch(
  requests: ToolCallRequest[],
  ctx: ToolExecutionContext
): Promise<ToolCallResult[]> {
  const scheduler = new ToolScheduler();
  const results: ToolCallResult[] = [];
  const calls: { tool: Tool; toolCallId: string; args: unknown }[] = [];
  for (const req of requests) {
    const tool = ctx.tools.get(req.name);
    if (!tool) {
      const result: ToolCallResult = { toolCallId: req.toolCallId, output: { error: `Unknown tool: ${req.name}` } };
      ctx.emit({ type: "tool.result", ...result });
      results.push(result);
      continue;
    }
    calls.push({ tool, toolCallId: req.toolCallId, args: req.arguments });
  }

  // Preflight
  const validatedCalls: typeof calls = [];
  for (const call of calls) {
    const parse = call.tool.parameters.safeParse(call.args);
    if (!parse.success) {
      const result = { toolCallId: call.toolCallId, output: { error: parse.error.message } };
      ctx.emit({ type: "tool.result", ...result });
      results.push(result);
      continue;
    }
    validatedCalls.push(call);
  }

  const batches = scheduler.schedule(validatedCalls);

  for (const batch of batches) {
    const batchResults = await Promise.all(
      batch.map(async (call) => {
        // P3-2（功能 M3）：单 call 隔离——approve/execute 任一抛错只影响本条，
        // 转为 error ToolResult 并照常发 tool.result 帧（与审批拒绝同构），
        // 整批/整轮不再因一条抛错而全崩，也不留无应答的孤儿 toolCall
        // （OpenAI 协议下孤儿 toolCalls 会污染后续轮次）。
        try {
          const approved = await ctx.approve(call.tool.name, call.args, call.toolCallId);
          if (!approved) {
            const result = { toolCallId: call.toolCallId, output: { error: "Approval denied" } };
            ctx.emit({ type: "tool.result", ...result });
            return result;
          }

          const toolCtx: ToolContext = {
            agentId: ctx.agentId,
            workspaceDir: ctx.workspaceDir,
            projectRoot: ctx.projectRoot,
            approve: ctx.approve,
            services: ctx.services,
          };
          const output = await call.tool.execute(toolCtx, call.args);
          const result = { toolCallId: call.toolCallId, output };
          ctx.emit({ type: "tool.result", ...result });
          return result;
        } catch (err) {
          const result = { toolCallId: call.toolCallId, output: { error: String(err) } };
          ctx.emit({ type: "tool.result", ...result });
          return result;
        }
      })
    );
    results.push(...batchResults);
  }

  return results;
}
