import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { resolveProjectPath } from "../project-paths.js";
import type { Tool, ToolContext, ToolResult } from "../types.js";

function resolveWorkspacePath(workspaceDir: string, filePath: string): string {
  if (path.isAbsolute(filePath)) {
    throw new Error("absolute paths are not allowed");
  }
  const fullPath = path.resolve(workspaceDir, filePath);
  const rel = path.relative(workspaceDir, fullPath);
  if (rel.startsWith("..") || rel === "..") {
    throw new Error("path traversal detected");
  }
  return fullPath;
}

function resolveReadPath(ctx: ToolContext, filePath: string): Promise<string> {
  if (ctx.projectRoot) {
    return resolveProjectPath(ctx.projectRoot, filePath);
  }
  return Promise.resolve(resolveWorkspacePath(ctx.workspaceDir, filePath));
}

export const readTool: Tool = {
  name: "read_file",
  description: "Read a file from the workspace or project root",
  parameters: z.object({ path: z.string() }),
  accesses: [{ resource: "file", action: "read" }],
  async execute(ctx: ToolContext, args: unknown): Promise<ToolResult> {
    const { path: filePath } = args as { path: string };
    try {
      const fullPath = await resolveReadPath(ctx, filePath);
      const content = await fs.readFile(fullPath, "utf-8");
      return { success: true, output: content };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  },
};
