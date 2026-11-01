import { spawn } from "node:child_process";
import path from "node:path";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../types.js";

const ALLOWED_COMMANDS = new Set(["ls", "cat", "echo", "pwd", "mkdir", "touch"]);
const MAX_OUTPUT_LENGTH = 1024 * 1024;
const TIMEOUT_MS = 30_000;

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
  // P3 看护：自报执行上限，避免长跑命令被看门狗当成卡死
  timeoutMs: TIMEOUT_MS,
  async execute(ctx: ToolContext, args: unknown): Promise<ToolResult> {
    const { command } = args as { command: string };
    const check = isDangerousCommand(command);
    if (check.dangerous) {
      return { success: false, error: `Command rejected: ${check.reason}` };
    }
    return new Promise((resolve) => {
      // detached 建独立进程组，超时/截断时整组 SIGKILL（shell 派生的孙进程一并收掉，
      // spawn 自带 timeout 只杀直接子进程会留孙进程残留——M15）。
      // Windows 无 POSIX 进程组信号，负 pid 不可用，退化为只杀直接子进程；
      // 完整进程树清理需 taskkill /T /F（见 mcp/client-manager.ts killProcessTree），
      // 白名单命令不派生孙进程，此处从简。
      const child = spawn(command, [], {
        shell: true,
        cwd: ctx.workspaceDir,
        detached: process.platform !== "win32",
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const settle = (result: ToolResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const killTree = () => {
        try {
          if (process.platform !== "win32" && child.pid !== undefined) {
            // 负 pid = 整个进程组（POSIX）
            process.kill(-child.pid, "SIGKILL");
          } else {
            child.kill("SIGKILL");
          }
        } catch {
          // 进程可能已退出，忽略
        }
      };
      const timer = setTimeout(() => {
        killTree();
        settle({
          success: false,
          output: stdout + stderr || undefined,
          error: `command timed out after ${TIMEOUT_MS}ms, process group killed`,
        });
      }, TIMEOUT_MS);
      const onData = () => {
        // 边收边查，超限立即杀进程组，避免海量输出撑爆内存；
        // 被截断/被杀属异常终止，按 success:false 返回（M15），截断内容留 output 供排查
        if (stdout.length + stderr.length > MAX_OUTPUT_LENGTH) {
          killTree();
          settle({
            success: false,
            output: (stdout + stderr).slice(0, MAX_OUTPUT_LENGTH),
            error: `output exceeded ${MAX_OUTPUT_LENGTH} bytes, process group killed and output truncated`,
          });
        }
      };
      child.stdout?.on("data", (data) => { stdout += data.toString(); onData(); });
      child.stderr?.on("data", (data) => { stderr += data.toString(); onData(); });
      child.on("error", (err) => settle({ success: false, error: String(err) }));
      child.on("close", (code) => {
        const combined = stdout + stderr;
        if (combined.length > MAX_OUTPUT_LENGTH) {
          // 兜底：onData 已拦过超限，正常到不了这里；万一到达同样按失败处理
          settle({
            success: false,
            output: combined.slice(0, MAX_OUTPUT_LENGTH),
            error: `output exceeded ${MAX_OUTPUT_LENGTH} bytes, output truncated`,
          });
          return;
        }
        if (code === 0) settle({ success: true, output: stdout || stderr });
        else settle({ success: false, error: stderr || `exit code ${code}` });
      });
    });
  },
};
