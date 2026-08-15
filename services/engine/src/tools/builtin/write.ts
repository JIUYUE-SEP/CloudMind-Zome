import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { renameWithRetry } from "../../plugins/memory/document-store.js";
import { resolveProjectPath } from "../project-paths.js";
import type { Tool, ToolContext, ToolResult } from "../types.js";

const PROTECTED_FILES = new Set([
  "agent.json",
  "messages.jsonl",
  "scheduler.jsonl",
  "memories.jsonl",
  "actions.jsonl",
  "config.json",
  ".master-key",
]);

async function resolveAllowedWritePath(
  workspaceDir: string,
  filePath: string,
): Promise<{ fullPath: string; relativePath: string }> {
  if (path.isAbsolute(filePath)) {
    throw new Error("absolute paths are not allowed");
  }

  const normalized = path.normalize(filePath);
  const basename = path.basename(normalized).toLowerCase();
  if (PROTECTED_FILES.has(basename)) {
    throw new Error(`cannot write protected file: ${filePath}`);
  }

  // P2-1：fallback 复用 resolveProjectPath（realpath 二次比较堵 junction/
  // symlink 写穿，安全 review 路径 Major-2；win32 小写比较顺带对齐 Minor-1，
  // 词法-only 的前缀比较已删）。root 仍是 workspaceDir/files（行为不变）；
  // files/ 可能尚不存在（首次写入），先建目录让 realpath 可解析
  const filesDir = path.join(workspaceDir, "files");
  await fs.mkdir(filesDir, { recursive: true });
  const fullPath = await resolveProjectPath(filesDir, normalized);
  return { fullPath, relativePath: normalized };
}

async function resolveWritePath(
  ctx: ToolContext,
  filePath: string,
): Promise<{ fullPath: string; relativePath: string }> {
  if (ctx.projectRoot) {
    const basename = path.basename(path.normalize(filePath)).toLowerCase();
    if (PROTECTED_FILES.has(basename)) {
      throw new Error(`cannot write protected file: ${filePath}`);
    }
    return {
      fullPath: await resolveProjectPath(ctx.projectRoot, filePath),
      relativePath: path.normalize(filePath),
    };
  }
  return resolveAllowedWritePath(ctx.workspaceDir, filePath);
}

export const writeTool: Tool = {
  name: "write_file",
  description: "Write content to a file in the workspace or project root",
  parameters: z.object({
    path: z.string(),
    content: z.string(),
  }),
  accesses: [{ resource: "file", action: "write" }],
  requiresApproval: true,
  async execute(ctx: ToolContext, args: unknown): Promise<ToolResult> {
    const { path: filePath, content } = args as { path: string; content: string };
    try {
      const { fullPath, relativePath } = await resolveWritePath(ctx, filePath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      // 原子写：先写 tmp 再 rename，避免写一半崩溃留下半截文件
      const tmpPath = `${fullPath}.tmp`;
      await fs.writeFile(tmpPath, content, "utf-8");
      await renameWithRetry(tmpPath, fullPath);
      return { success: true, output: `Wrote ${relativePath}` };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  },
};
