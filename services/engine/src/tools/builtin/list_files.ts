import fs from "node:fs/promises";
import { z } from "zod";
import { resolveProjectPath } from "../project-paths.js";
import type { Tool, ToolContext, ToolResult } from "../types.js";

const parameters = z.object({
  path: z.string().default("."),
  recursive: z.boolean().default(false),
});

export const listFilesTool: Tool = {
  name: "list_files",
  description: "List files and directories under a project path",
  parameters,
  accesses: [{ resource: "file", action: "read" }],
  async execute(ctx: ToolContext, args: unknown): Promise<ToolResult> {
    const { path: relativePath, recursive } = parameters.parse(args);

    const projectRoot = (ctx as unknown as { projectRoot?: string }).projectRoot;
    if (!projectRoot) {
      return { success: false, error: "No project root configured" };
    }

    if (recursive) {
      return { success: false, error: "Recursive listing is not implemented" };
    }

    try {
      const targetPath = resolveProjectPath(projectRoot, relativePath);
      const dirents = await fs.readdir(targetPath, { withFileTypes: true });
      const entries = dirents.map((dirent) => ({
        name: dirent.name,
        type: dirent.isDirectory() ? "directory" : "file",
      }));
      return { success: true, output: { entries } };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  },
};
