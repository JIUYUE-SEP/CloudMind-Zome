import fs from "node:fs/promises";
import { z } from "zod";
import { resolveProjectPath } from "../project-paths.js";
import type { Tool, ToolContext, ToolResult } from "../types.js";

const parameters = z.object({
  path: z.string(),
  oldString: z.string(),
  newString: z.string(),
});

function countOccurrences(content: string, search: string): number {
  if (search.length === 0) {
    return content.length + 1;
  }

  let count = 0;
  let position = 0;

  while ((position = content.indexOf(search, position)) !== -1) {
    count += 1;
    position += search.length;
  }

  return count;
}

export const editFileTool: Tool = {
  name: "edit_file",
  description: "Replace a unique occurrence of oldString with newString in a project file",
  parameters,
  accesses: [{ resource: "file", action: "write" }],
  requiresApproval: true,
  async execute(ctx: ToolContext, args: unknown): Promise<ToolResult> {
    const projectRoot = ctx.projectRoot;
    if (!projectRoot) {
      return { success: false, error: "No project root configured" };
    }

    try {
      const { path: filePath, oldString, newString } = parameters.parse(args);

      if (oldString === "") {
        return { success: false, error: "oldString must not be empty" };
      }

      const fullPath = resolveProjectPath(projectRoot, filePath);
      const content = await fs.readFile(fullPath, "utf-8");
      const occurrences = countOccurrences(content, oldString);

      if (occurrences === 0) {
        return { success: false, error: `oldString not found in ${filePath}` };
      }

      if (occurrences > 1) {
        return {
          success: false,
          error: `oldString is not unique in ${filePath} (${occurrences} occurrences)`,
        };
      }

      const updated = content.replace(oldString, () => newString);
      await fs.writeFile(fullPath, updated, "utf-8");
      return { success: true, output: `Edited ${filePath}` };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};
