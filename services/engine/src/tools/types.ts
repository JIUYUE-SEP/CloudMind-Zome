import type { ZodTypeAny } from "zod";
import type { SubagentDispatcher } from "../subagent/dispatcher.js";

export interface ToolAccess {
  resource: "file" | "network" | "process" | "memory";
  action: "read" | "write" | "execute";
  path?: string;
}

/** 可注入工具执行上下文的生产服务（按需在 bootstrap 组装） */
export interface ToolServices {
  subagentDispatcher?: SubagentDispatcher;
}

export interface ToolContext {
  agentId: string;
  workspaceDir: string;
  projectRoot?: string;
  /** 返回 true 表示允许执行该工具调用；返回 false 则以 "Approval denied" 拒绝。 */
  approve: (toolName: string, args: unknown, toolCallId: string) => boolean | Promise<boolean>;
  services?: ToolServices;
}

export interface ToolResult {
  success: boolean;
  output?: unknown;
  error?: string;
}

export interface Tool {
  name: string;
  description: string;
  parameters: ZodTypeAny;
  accesses: ToolAccess[];
  /** 为 true 时，执行前需要人工审批（无审批通道的调用一律拒绝） */
  requiresApproval?: boolean;
  execute: (ctx: ToolContext, args: unknown) => Promise<ToolResult>;
}
