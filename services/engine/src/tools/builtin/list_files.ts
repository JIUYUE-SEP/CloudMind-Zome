import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import { z } from "zod";
import { resolveProjectPath } from "../project-paths.js";
import type { Tool, ToolContext, ToolResult } from "../types.js";

const parameters = z.object({
  path: z.string().default("."),
  recursive: z.boolean().default(false),
});

function getEntryType(dirent: Dirent): "directory" | "symlink" | "file" | "other" {
  if (dirent.isDirectory()) return "directory";
  if (dirent.isSymbolicLink()) return "symlink";
  if (dirent.isFile()) return "file";
  return "other";
}

export const listFilesTool: Tool = {
  name: "list_files",
  description: "List files and directories under a project path",
  parameters,
  accesses: [{ resource: "file", action: "read" }],
  async execute(ctx: ToolContext, args: unknown): Promise<ToolResult> {
    const projectRoot = ctx.projectRoot;
    if (!projectRoot) {
      return { success: false, error: "No project root configured" };
    }

    try {
      const { path: relativePath, recursive } = parameters.parse(args);

      if (recursive) {
        return { success: false, error: "Recursive listing is not implemented" };
      }

      const targetPath = await resolveProjectPath(projectRoot, relativePath);
      const dirents = await fs.readdir(targetPath, { withFileTypes: true });
      const entries = dirents.map((dirent) => ({
        name: dirent.name,
        type: getEntryType(dirent),
      }));
      return { success: true, output: { entries } };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  },
};
