import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../types.js";

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
    const fullPath = path.resolve(ctx.workspaceDir, filePath);
    try {
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, content, "utf-8");
      return { success: true, output: `Wrote ${fullPath}` };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  },
};
