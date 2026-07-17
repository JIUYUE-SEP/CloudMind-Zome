import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
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

function resolveAllowedWritePath(
  workspaceDir: string,
  filePath: string,
): { fullPath: string; relativePath: string } {
  if (path.isAbsolute(filePath)) {
    throw new Error("absolute paths are not allowed");
  }

  const normalized = path.normalize(filePath);
  const basename = path.basename(normalized).toLowerCase();
  if (PROTECTED_FILES.has(basename)) {
    throw new Error(`cannot write protected file: ${filePath}`);
  }

  const filesDir = path.join(workspaceDir, "files");
  const fullPath = path.resolve(filesDir, normalized);
  const resolvedFilesDir = path.resolve(filesDir);

  if (
    fullPath !== resolvedFilesDir &&
    !fullPath.startsWith(resolvedFilesDir + path.sep)
  ) {
    throw new Error("path is outside allowed workspace");
  }

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
      await fs.writeFile(fullPath, content, "utf-8");
      return { success: true, output: `Wrote ${relativePath}` };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  },
};
