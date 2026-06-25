import { spawn } from "node:child_process";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../types.js";

export const bashTool: Tool = {
  name: "bash",
  description: "Execute a shell command in the workspace (requires approval)",
  parameters: z.object({
    command: z.string(),
    timeout: z.number().optional(),
  }),
  accesses: [{ resource: "process", action: "execute" }],
  async execute(ctx: ToolContext, args: unknown): Promise<ToolResult> {
    const approved = await ctx.requiresApproval("bash", args);
    if (!approved) {
      return { success: false, error: "User rejected the bash command" };
    }

    const { command, timeout = 30000 } = args as {
      command: string;
      timeout?: number;
    };

    return new Promise((resolve) => {
      const child = spawn(command, { shell: true, cwd: ctx.workspaceDir });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        resolve({ success: false, error: `Timeout after ${timeout}ms` });
      }, timeout);

      child.stdout.on("data", (data: Buffer) => {
        stdout += data.toString("utf-8");
      });
      child.stderr.on("data", (data: Buffer) => {
        stderr += data.toString("utf-8");
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ success: false, error: String(err) });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve({ success: true, output: stdout });
        } else {
          resolve({
            success: false,
            error: `Exit code ${code}: ${stderr || stdout}`,
          });
        }
      });
    });
  },
};
