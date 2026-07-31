import { readTool } from "./read.js";
import { writeTool } from "./write.js";
import { bashTool } from "./bash.js";
import { listFilesTool } from "./list_files.js";
import { editFileTool } from "./edit_file.js";
import { runCommandTool } from "./run_command.js";
import { dispatchSubagentTool } from "./dispatch_subagent.js";
import { dispatchSubagentBatchTool } from "./dispatch_subagent_batch.js";
import type { Tool } from "../types.js";

export function getBuiltinTools(): Tool[] {
  return [
    readTool,
    writeTool,
    bashTool,
    listFilesTool,
    editFileTool,
    runCommandTool,
    dispatchSubagentTool,
    dispatchSubagentBatchTool,
  ];
}
