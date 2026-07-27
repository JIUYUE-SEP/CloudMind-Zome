import fs from "node:fs/promises";
import { z } from "zod";
import { resolveProjectPath } from "../project-paths.js";
import type { Tool, ToolContext, ToolResult } from "../types.js";

function resolveReadPath(ctx: ToolContext, filePath: string): Promise<string> {
  // P2-1：fallback（chat/scheduler/subagent/blueprint）与 code 模式同一实现——
  // resolveProjectPath 自带 realpath 二次比较，堵 junction/symlink 逃逸
  // （安全 review 路径 Major-1）；词法-only 的 resolveWorkspacePath 已删
  return resolveProjectPath(ctx.projectRoot ?? ctx.workspaceDir, filePath);
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
