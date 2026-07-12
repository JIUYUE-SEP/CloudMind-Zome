import { spawn } from "node:child_process";
import { z } from "zod";
import { resolveProjectPath } from "../project-paths.js";
import type { Tool, ToolContext, ToolResult } from "../types.js";

const parameters = z.object({
  command: z.string(),
  cwd: z.string().default("."),
  timeout: z.number().default(60),
});

function isBlockedCommand(command: string): boolean {
  const lower = command.toLowerCase();
  const dangerousPatterns = [
    /rm\s+-rf\s+\//,
    /curl\s+.*\|\s*sh/,
    /\bmkfs\b/,
    /\bdd\s+if=/,
  ];
  return dangerousPatterns.some((pattern) => pattern.test(lower));
}

export const runCommandTool: Tool = {
  name: "run_command",
  description: "Execute a shell command under the project root",
  parameters,
  accesses: [{ resource: "process", action: "execute" }],
  async execute(ctx: ToolContext, args: unknown): Promise<ToolResult> {
    const projectRoot = (ctx as unknown as { projectRoot?: string }).projectRoot;
    if (!projectRoot) {
      return { success: false, error: "No project root configured" };
    }

    let parsed: { command: string; cwd: string; timeout: number };
    try {
      parsed = parameters.parse(args);
    } catch (err) {
      return { success: false, error: String(err) };
    }

    const { command, cwd, timeout } = parsed;

    let targetCwd: string;
    try {
      targetCwd = resolveProjectPath(projectRoot, cwd);
    } catch (err) {
      return { success: false, error: String(err) };
    }

    if (isBlockedCommand(command)) {
      return { success: false, error: "Command blocked for security reasons" };
    }

    return new Promise((resolve) => {
      const child = spawn(command, [], { shell: true, cwd: targetCwd });
      let stdout = "";
      let stderr = "";
      let settled = false;

      const settle = (result: ToolResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      const timeoutMs = timeout * 1000;
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        settle({
          success: false,
          error: `Command timed out after ${timeout} seconds`,
          output: { stdout, stderr, exitCode: -1 },
        });
      }, timeoutMs);

      child.stdout?.on("data", (data) => {
        stdout += data.toString();
      });
      child.stderr?.on("data", (data) => {
        stderr += data.toString();
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        settle({ success: false, error: String(err) });
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        settle({
          success: true,
          output: {
            stdout,
            stderr,
            exitCode: code ?? -1,
          },
        });
      });
    });
  },
};
