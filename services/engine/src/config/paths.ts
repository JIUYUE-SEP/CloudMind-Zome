import path from "node:path";
import os from "node:os";
import { AGENT_ID_CHARSET_PATTERN, AGENT_ID_MAX_LENGTH } from "@mindcloud/shared";

export function getDataDir(): string {
  return process.env.CLOUDMIND_DATA_DIR || path.join(os.homedir(), ".cloudmind-zome");
}

export function getAgentDir(agentId: string): string {
  return path.join(getDataDir(), "agents", agentId);
}

export function sanitizeAgentId(agentId: string): string {
  if (!agentId || agentId.length > AGENT_ID_MAX_LENGTH) {
    throw new Error("invalid agent_id length");
  }
  if (!AGENT_ID_CHARSET_PATTERN.test(agentId)) {
    throw new Error("agent_id contains invalid characters");
  }
  return agentId;
}
