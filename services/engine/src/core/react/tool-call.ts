import type { Tool, ToolContext } from "../../tools/types.js";
import type { LLMEvent } from "../../provider/types.js";
import type { ActionRecord } from "../../memory/repositories/types.js";
import { logger } from "../../logger.js";
import { summarizeArgs } from "../../plugins/approval-audit/index.js";
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
  /** puppet 上下文标记（透传给工具：send_private_message 硬拒） */
  isPuppet?: boolean;
  /** 私信唤醒回合标记（透传给工具：回信搭车不唤醒） */
  intermindRide?: boolean;
  approve: (toolName: string, args: unknown, toolCallId: string) => boolean | Promise<boolean>;
  emit: (event: LLMEvent) => void;
  /**
   * 工具调用落档回调（H1：actions.jsonl 唯一写入方）：每条调用完成后
   * （成功/失败/审批拒绝均算）记一条 ActionRecord。可选——傀儡/蓝图路径不接。
   */
  recordAction?: (record: ActionRecord) => void;
  services?: ToolContext["services"];
}

/** 落档状态判定（H1）：execute 抛错/审批拒绝（内部 { error } 形状）或工具自报失败均计 failed */
function isFailedOutput(output: unknown): boolean {
  if (output && typeof output === "object") {
    const o = output as Record<string, unknown>;
    if (typeof o.error === "string") return true;
    if (o.success === false) return true;
  }
  return false;
}

/**
 * ActionRecord 构造（H1）：id 用 toolCallId（与 tool.result 帧/消息同键，可对账）；
 * description = 工具名 + 参数摘要——summarizeArgs 与审批审计同口径脱敏截断，
 * 大段参数原文不落盘。
 */
function buildActionRecord(
  call: { tool: Tool; toolCallId: string; args: unknown },
  result: ToolCallResult,
): ActionRecord {
  const now = new Date().toISOString();
  return {
    id: call.toolCallId,
    status: isFailedOutput(result.output) ? "failed" : "completed",
    description: `${call.tool.name}(${summarizeArgs(call.tool.name, call.args)})`,
    createdAt: now,
    updatedAt: now,
  };
}

/** H1：落档是旁路——回调抛错只 warn，绝不击穿本条工具结果与单 call 隔离 */
function recordActionSafe(
  ctx: ToolExecutionContext,
  call: { tool: Tool; toolCallId: string; args: unknown },
  result: ToolCallResult,
): void {
  if (!ctx.recordAction) return;
  try {
    ctx.recordAction(buildActionRecord(call, result));
  } catch (err) {
    logger.warn({ err: err }, "[action] 工具调用落档回调失败（已忽略）");
  }
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
            recordActionSafe(ctx, call, result);
            return result;
          }

          const toolCtx: ToolContext = {
            agentId: ctx.agentId,
            workspaceDir: ctx.workspaceDir,
            projectRoot: ctx.projectRoot,
            isPuppet: ctx.isPuppet,
            intermindRide: ctx.intermindRide,
            approve: ctx.approve,
            services: ctx.services,
          };
          const output = await call.tool.execute(toolCtx, call.args);
          const result = { toolCallId: call.toolCallId, output };
          ctx.emit({ type: "tool.result", ...result });
          recordActionSafe(ctx, call, result);
          return result;
        } catch (err) {
          const result = { toolCallId: call.toolCallId, output: { error: String(err) } };
          ctx.emit({ type: "tool.result", ...result });
          recordActionSafe(ctx, call, result);
          return result;
        }
      })
    );
    results.push(...batchResults);
  }

  return results;
}
