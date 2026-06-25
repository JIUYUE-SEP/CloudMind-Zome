import { spawn } from "node:child_process";
import path from "node:path";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../types.js";

const COMMAND_TIMEOUT_MS = 30000;
const KILL_GRACE_MS = 5000;

function isDangerousCommand(command: string): boolean {
  if (path.isAbsolute(command)) return true;
  if (command.includes("/")) return true;
  if (
    command.includes(";") ||
    command.includes("&&") ||
    command.includes("||") ||
    command.includes("`") ||
    command.includes("$") ||
    command.includes("|") ||
    command.includes("<") ||
    command.includes(">") ||
    command.includes("{") ||
    command.includes("}") ||
    command.includes("[") ||
    command.includes("]")
  )
    return true;
  return false;
}

export const bashTool: Tool = {
  name: "bash",
  description: "Execute a bash command in the workspace (requires approval)",
  parameters: z.object({
    command: z.string().max(4096),
  }),
  accesses: [{ resource: "process", action: "execute" }],
  async execute(ctx: ToolContext, args: unknown): Promise<ToolResult> {
    const { command } = args as { command: string };

    if (!command.trim()) {
      return { success: false, error: "Empty command" };
    }

    if (isDangerousCommand(command.trim())) {
      return { success: false, error: "Complex shell constructs are not allowed" };
    }

    return new Promise((resolve) => {
      const child = spawn(command, [], { shell: true, cwd: ctx.workspaceDir });
      let stdout = "";
      let stderr = "";
      let settled = false;

      const settle = (result: ToolResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(termTimer);
        clearTimeout(killTimer);
        resolve(result);
      };

      const termTimer = setTimeout(() => {
        child.kill("SIGTERM");
        killTimer = setTimeout(() => {
          child.kill("SIGKILL");
          settle({ success: false, error: `Timeout after ${COMMAND_TIMEOUT_MS}ms` });
        }, KILL_GRACE_MS);
      }, COMMAND_TIMEOUT_MS);

      let killTimer: ReturnType<typeof setTimeout> | undefined;

      child.stdout?.on("data", (data: Buffer) => {
        stdout += data.toString("utf-8");
      });
      child.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString("utf-8");
      });
      child.on("error", (err) => {
        settle({ success: false, error: String(err) });
      });
      child.on("close", (code) => {
        if (code === 0) {
          settle({ success: true, output: stdout || stderr });
        } else {
          settle({ success: false, error: stderr || `exit code ${code}` });
        }
      });
    });
  },
};
