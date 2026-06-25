import path from "node:path";
import os from "node:os";

export function getDataDir(): string {
  return process.env.CLOUDMIND_DATA_DIR || path.join(os.homedir(), ".cloudmind-zome");
}

export function getAgentDir(agentId: string): string {
  return path.join(getDataDir(), "agents", agentId);
}

export function sanitizeAgentId(agentId: string): string {
  if (!agentId || agentId.length > 64) {
    throw new Error("invalid agent_id length");
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(agentId)) {
    throw new Error("agent_id contains invalid characters");
  }
  return agentId;
}
