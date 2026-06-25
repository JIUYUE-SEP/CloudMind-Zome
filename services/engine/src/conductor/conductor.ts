import type { Session } from "./types.js";
import type { AgentConfig } from "@mindcloud/shared";

export interface RoutingResult {
  targetAgentIds: string[];
  mentionAll: boolean;
}

export function routeMessage(text: string, session: Session, agents: AgentConfig[]): RoutingResult {
  const mentions = parseMentions(text);
  if (mentions.length > 0) {
    const targetAgentIds = mentions
      .map((m) => resolveMention(m, agents))
      .filter((id): id is string => !!id)
      .filter((id) => session.agentIds.includes(id));
    return { targetAgentIds, mentionAll: false };
  }
  return { targetAgentIds: session.agentIds, mentionAll: true };
}

function parseMentions(text: string): string[] {
  const matches = text.match(/@([a-zA-Z0-9_\-\u4e00-\u9fa5]+)/g);
  return matches ? matches.map((m) => m.slice(1)) : [];
}

function resolveMention(mention: string, agents: AgentConfig[]): string | undefined {
  const byId = agents.find((a) => a.id === mention);
  if (byId) return byId.id;
  const byName = agents.find((a) => a.name === mention);
  return byName?.id;
}
