import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { renameWithRetry } from "../../plugins/memory/document-store.js";
import { resolveProjectPath } from "../project-paths.js";
import { PROTECTED_FILES } from "./write.js";
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
    // 生产装配点不注入 projectRoot，缺省回落 workspaceDir（同 read_file）
    const projectRoot = ctx.projectRoot ?? ctx.workspaceDir;

    try {
      const { path: filePath, oldString, newString } = parameters.parse(args);

      if (oldString === "") {
        return { success: false, error: "oldString must not be empty" };
      }

      // M17：引擎自管状态文件禁改（与 write.ts 同名单同语义，basename 小写比较）
      const basename = path.basename(path.normalize(filePath)).toLowerCase();
      if (PROTECTED_FILES.has(basename)) {
        return { success: false, error: `cannot edit protected file: ${filePath}` };
      }

      const fullPath = await resolveProjectPath(projectRoot, filePath);
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
      // 原子写：先写 tmp 再 rename，避免写一半崩溃留下半截文件
      const tmpPath = `${fullPath}.tmp`;
      await fs.writeFile(tmpPath, updated, "utf-8");
      await renameWithRetry(tmpPath, fullPath);
      return { success: true, output: `Edited ${filePath}` };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};
