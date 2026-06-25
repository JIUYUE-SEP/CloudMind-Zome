import { readTool } from "./read.js";
import { writeTool } from "./write.js";
import { bashTool } from "./bash.js";
import type { Tool } from "../types.js";

export function getBuiltinTools(): Tool[] {
  return [readTool, writeTool, bashTool];
}
