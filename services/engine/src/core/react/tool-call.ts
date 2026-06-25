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
  tools: Map<string, Tool>;
  requiresApproval: (toolName: string, args: unknown) => boolean | Promise<boolean>;
  emit: (event: LLMEvent) => void;
}

export async function runToolCallBatch(
  requests: ToolCallRequest[],
  ctx: ToolExecutionContext
): Promise<ToolCallResult[]> {
  const scheduler = new ToolScheduler();
  const calls = requests
    .map((req) => {
      const tool = ctx.tools.get(req.name);
      if (!tool) return undefined;
      return { tool, toolCallId: req.toolCallId, args: req.arguments };
    })
    .filter((x): x is NonNullable<typeof x> => x !== undefined);

  const results: ToolCallResult[] = [];

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
        const approved = await ctx.requiresApproval(call.tool.name, call.args);
        if (!approved) {
          const result = { toolCallId: call.toolCallId, output: { error: "Approval denied" } };
          ctx.emit({ type: "tool.result", ...result });
          return result;
        }

        const toolCtx: ToolContext = {
          agentId: ctx.agentId,
          workspaceDir: ctx.workspaceDir,
          requiresApproval: ctx.requiresApproval,
        };
        const output = await call.tool.execute(toolCtx, call.args);
        const result = { toolCallId: call.toolCallId, output };
        ctx.emit({ type: "tool.result", ...result });
        return result;
      })
    );
    results.push(...batchResults);
  }

  return results;
}
