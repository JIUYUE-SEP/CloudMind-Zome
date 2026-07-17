import { spawn } from "node:child_process";
import { z } from "zod";
import { resolveProjectPath } from "../project-paths.js";
import type { Tool, ToolContext, ToolResult } from "../types.js";

export const MAX_OUTPUT_SIZE = 1024 * 1024; // 1 MB
export const MAX_TIMEOUT_SECONDS = 600;
const SIGTERM_GRACE_MS = 5000;

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

function isValidTimeout(timeout: number): boolean {
  return Number.isFinite(timeout) && timeout > 0 && timeout <= MAX_TIMEOUT_SECONDS && Number.isInteger(timeout);
}

function truncateOutput(
  stdout: Buffer,
  stderr: Buffer,
  maxBytes: number,
): { stdout: string; stderr: string } {
  const total = stdout.length + stderr.length;
  if (total <= maxBytes) {
    return { stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") };
  }

  const ratio = maxBytes / total;
  const outLimit = Math.max(0, Math.floor(stdout.length * ratio));
  const errLimit = Math.max(0, Math.floor(stderr.length * ratio));
  return {
    stdout: stdout.subarray(0, outLimit).toString("utf8") + "\n[stdout truncated]",
    stderr: stderr.subarray(0, errLimit).toString("utf8") + "\n[stderr truncated]",
  };
}

export const runCommandTool: Tool = {
  name: "run_command",
  // 注意：这是无沙箱的任意 shell 执行（shell:true），cwd 限制不是安全边界，
  // 黑名单只是兜底，不能视为防护。仅应在 code 模式 / 用户知情场景下启用。
  description:
    "Execute an arbitrary shell command under the project root (UNSANDBOXED: the command can access the whole machine; cwd is not a security boundary)",
  parameters,
  accesses: [{ resource: "process", action: "execute" }],
  requiresApproval: true,
  async execute(ctx: ToolContext, args: unknown): Promise<ToolResult> {
    const projectRoot = ctx.projectRoot;
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

    if (!isValidTimeout(timeout)) {
      return { success: false, error: `timeout must be a positive integer (seconds, max ${MAX_TIMEOUT_SECONDS})` };
    }

    let targetCwd: string;
    try {
      targetCwd = await resolveProjectPath(projectRoot, cwd);
    } catch (err) {
      return { success: false, error: String(err) };
    }

    if (isBlockedCommand(command)) {
      return { success: false, error: "Command blocked for security reasons" };
    }

    return new Promise((resolve) => {
      const child = spawn(command, [], { shell: true, cwd: targetCwd });
      let stdoutBuf = Buffer.alloc(0);
      let stderrBuf = Buffer.alloc(0);
      let settled = false;
      let timedOut = false;
      let killedForOutputLimit = false;
      let sigkillTimer: ReturnType<typeof setTimeout> | undefined;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        sigkillTimer = setTimeout(() => {
          child.kill("SIGKILL");
        }, SIGTERM_GRACE_MS);
      }, timeout * 1000);

      const settle = (result: ToolResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (sigkillTimer) clearTimeout(sigkillTimer);
        resolve(result);
      };

      const checkOutputLimit = () => {
        if (killedForOutputLimit) return;
        if (stdoutBuf.length + stderrBuf.length > MAX_OUTPUT_SIZE) {
          killedForOutputLimit = true;
          child.kill("SIGKILL");
          const { stdout, stderr } = truncateOutput(stdoutBuf, stderrBuf, MAX_OUTPUT_SIZE);
          settle({
            success: false,
            error: `Command output exceeded ${MAX_OUTPUT_SIZE} bytes limit`,
            output: { stdout, stderr, exitCode: -1 },
          });
        }
      };

      child.stdout?.on("data", (data: Buffer) => {
        stdoutBuf = Buffer.concat([stdoutBuf, data]);
        checkOutputLimit();
      });
      child.stderr?.on("data", (data: Buffer) => {
        stderrBuf = Buffer.concat([stderrBuf, data]);
        checkOutputLimit();
      });

      child.on("error", (err) => {
        const { stdout, stderr } = truncateOutput(stdoutBuf, stderrBuf, MAX_OUTPUT_SIZE);
        settle({
          success: false,
          error: String(err),
          output: { stdout, stderr, exitCode: -1 },
        });
      });

      child.on("close", (code, signal) => {
        if (settled) return;

        const { stdout, stderr } = truncateOutput(stdoutBuf, stderrBuf, MAX_OUTPUT_SIZE);

        if (timedOut) {
          settle({
            success: false,
            error: `Command timed out after ${timeout} seconds`,
            output: { stdout, stderr, exitCode: -1 },
          });
          return;
        }

        const exitCode = code ?? -1;
        if (exitCode === 0) {
          settle({
            success: true,
            output: { stdout, stderr, exitCode },
          });
        } else {
          settle({
            success: false,
            error: signal ? `Command terminated by ${signal}` : `Command exited with code ${exitCode}`,
            output: { stdout, stderr, exitCode },
          });
        }
      });
    });
  },
};
