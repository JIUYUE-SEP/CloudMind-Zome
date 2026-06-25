import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../types.js";

export const readTool: Tool = {
  name: "read_file",
  description: "Read a file from the workspace",
  parameters: z.object({ path: z.string() }),
  accesses: [{ resource: "file", action: "read" }],
  async execute(ctx: ToolContext, args: unknown): Promise<ToolResult> {
    const { path: filePath } = args as { path: string };
    const fullPath = path.resolve(ctx.workspaceDir, filePath);
    try {
      const content = await fs.readFile(fullPath, "utf-8");
      return { success: true, output: content };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  },
};
