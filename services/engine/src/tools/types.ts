import type { ZodTypeAny } from "zod";

export interface ToolAccess {
  resource: "file" | "network" | "process" | "memory";
  action: "read" | "write" | "execute";
  path?: string;
}

export interface ToolContext {
  agentId: string;
  workspaceDir: string;
  requiresApproval: (toolName: string, args: unknown) => boolean | Promise<boolean>;
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
  execute: (ctx: ToolContext, args: unknown) => Promise<ToolResult>;
}
