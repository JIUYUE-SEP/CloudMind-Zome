import { spawn } from "node:child_process";
import path from "node:path";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../types.js";

const ALLOWED_COMMANDS = new Set(["ls", "cat", "echo", "pwd", "mkdir", "touch"]);
const MAX_OUTPUT_LENGTH = 1024 * 1024;

function isDangerousCommand(command: string): { dangerous: boolean; reason?: string } {
  if (/[\r\n]/.test(command)) return { dangerous: true, reason: "newlines are not allowed" };
  if (/[|;`$()<>{\}\[\]*?#~!&\\%]/.test(command)) {
    return { dangerous: true, reason: "shell metacharacters are not allowed" };
  }
  const parts = command.trim().split(/\s+/);
  if (parts.length === 0) return { dangerous: true, reason: "empty command" };
  if (parts.slice(1).includes("-")) {
    return { dangerous: true, reason: "interactive/stdin wait not allowed" };
  }
  const first = parts[0];
  // 含 / 的一律拒绝：既挡绝对路径与目录参数，也挡住 ./script.sh 这类相对脚本执行
  // （否则 write_file 写个脚本再 ./ 执行即可绕过白名单）
  if (command.includes("/")) {
    return { dangerous: true, reason: "slashes are not allowed" };
  }
  if (!ALLOWED_COMMANDS.has(first)) {
    return { dangerous: true, reason: `command "${first}" is not in allowlist` };
  }
  // validate arguments: reject absolute paths, .., and paths with backslash
  for (let i = 1; i < parts.length; i++) {
    const arg = parts[i];
    if (path.isAbsolute(arg)) return { dangerous: true, reason: "absolute paths are not allowed" };
    if (arg.includes("..") || arg.includes("\\")) {
      return { dangerous: true, reason: "path traversal or backslash in argument" };
    }
  }
  return { dangerous: false };
}

export const bashTool: Tool = {
  name: "bash",
  description: "Execute an allowed shell command in the workspace",
  parameters: z.object({ command: z.string().max(4096) }),
  accesses: [{ resource: "process", action: "execute" }],
  requiresApproval: true,
  async execute(ctx: ToolContext, args: unknown): Promise<ToolResult> {
    const { command } = args as { command: string };
    const check = isDangerousCommand(command);
    if (check.dangerous) {
      return { success: false, error: `Command rejected: ${check.reason}` };
    }
    return new Promise((resolve) => {
      const child = spawn(command, [], { shell: true, cwd: ctx.workspaceDir, timeout: 30000 });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const settle = (result: ToolResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const onData = (data: Buffer) => {
        // 边收边查，超限立即杀进程，避免海量输出撑爆内存
        if (stdout.length + stderr.length > MAX_OUTPUT_LENGTH) {
          child.kill("SIGKILL");
          const combined = (stdout + stderr).slice(0, MAX_OUTPUT_LENGTH);
          settle({
            success: true,
            output: combined + `\n\n[output truncated: exceeded ${MAX_OUTPUT_LENGTH} bytes]`,
          });
        }
      };
      child.stdout?.on("data", (data) => { stdout += data.toString(); onData(data); });
      child.stderr?.on("data", (data) => { stderr += data.toString(); onData(data); });
      child.on("error", (err) => settle({ success: false, error: String(err) }));
      child.on("close", (code) => {
        const combined = stdout + stderr;
        if (combined.length > MAX_OUTPUT_LENGTH) {
          settle({
            success: true,
            output: combined.slice(0, MAX_OUTPUT_LENGTH) + `\n\n[output truncated: exceeded ${MAX_OUTPUT_LENGTH} bytes]`,
          });
          return;
        }
        if (code === 0) settle({ success: true, output: stdout || stderr });
        else settle({ success: false, error: stderr || `exit code ${code}` });
      });
    });
  },
};
