import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
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

export const writeTool: Tool = {
  name: "write_file",
  description: "Write content to a file in the workspace",
  parameters: z.object({
    path: z.string(),
    content: z.string(),
  }),
  accesses: [{ resource: "file", action: "write" }],
  async execute(ctx: ToolContext, args: unknown): Promise<ToolResult> {
    const { path: filePath, content } = args as { path: string; content: string };
    try {
      const fullPath = resolveWorkspacePath(ctx.workspaceDir, filePath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, content, "utf-8");
      return { success: true, output: `Wrote ${fullPath}` };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  },
};
