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

/** 温和终止：POSIX 下对整个进程组发信号（子进程 detached，是组长） */
function signalProcessTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // 进程组已不存在，退回只杀子进程
    }
  }
  child.kill(signal);
}

/**
 * 强制杀掉整棵进程树。shell:true 时 child 只是壳（sh/cmd），
 * 只杀壳会留下孙进程孤儿：Windows 用 taskkill /T 杀进程树，
 * POSIX 用负 pid 杀整个进程组（配合 spawn 的 detached）。
 * 返回的 Promise 在 kill 生效后 resolve，调用方应等待它再上报结果，
 * 否则调用方（如测试清理）会在进程未死透时竞争资源。
 */
function killProcessTree(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.pid === undefined) return Promise.resolve();
  if (process.platform === "win32") {
    return new Promise((resolve) => {
      const tk = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      tk.on("error", () => resolve());
      tk.on("exit", () => resolve());
    });
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
  return Promise.resolve();
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
      const child = spawn(command, [], {
        shell: true,
        cwd: targetCwd,
        // POSIX 下设为进程组组长，便于整组终止；Windows 不开（避免弹新控制台）
        detached: process.platform !== "win32",
      });
      let stdoutBuf = Buffer.alloc(0);
      let stderrBuf = Buffer.alloc(0);
      let settled = false;
      let timedOut = false;
      let killedForOutputLimit = false;
      let sigkillTimer: ReturnType<typeof setTimeout> | undefined;

      const timer = setTimeout(() => {
        timedOut = true;
        signalProcessTree(child, "SIGTERM");
        sigkillTimer = setTimeout(() => {
          void killProcessTree(child);
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
          // 等进程树死透再上报，避免调用方在进程未退出时竞争资源（如删除 cwd）
          void killProcessTree(child).then(() => {
            const { stdout, stderr } = truncateOutput(stdoutBuf, stderrBuf, MAX_OUTPUT_SIZE);
            settle({
              success: false,
              error: `Command output exceeded ${MAX_OUTPUT_SIZE} bytes limit`,
              output: { stdout, stderr, exitCode: -1 },
            });
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
        // 超限触发的异步 kill-settle 进行中时，由它负责最终结论
        if (killedForOutputLimit) return;
        const { stdout, stderr } = truncateOutput(stdoutBuf, stderrBuf, MAX_OUTPUT_SIZE);
        settle({
          success: false,
          error: String(err),
          output: { stdout, stderr, exitCode: -1 },
        });
      });

      child.on("close", (code, signal) => {
        // 超限触发的异步 kill-settle 进行中时，由它负责最终结论；
        // 否则子进程可能抢在 taskkill 生效前以 code 0 退出，误报 success
        if (settled || killedForOutputLimit) return;

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
