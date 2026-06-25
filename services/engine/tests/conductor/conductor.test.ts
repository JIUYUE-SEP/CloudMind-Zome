import { describe, it, expect } from "vitest";
import { routeMessage } from "../../src/conductor/conductor.js";
import type { Session } from "../../src/conductor/types.js";
import type { AgentConfig } from "@mindcloud/shared";

describe("routeMessage", () => {
  const session: Session = {
    id: "s1",
    name: "Test",
    agentIds: ["a1", "a2"],
    type: "group",
    createdAt: "2024-01-01",
    updatedAt: "2024-01-01",
  };

  const agents: AgentConfig[] = [
    { id: "a1", name: "Alice", persona: "", model: "mock", skills: [], tools: [] },
    { id: "a2", name: "Bob", persona: "", model: "mock", skills: [], tools: [] },
  ];

  it("routes to all agents when no mention", () => {
    const result = routeMessage("hello", session, agents);
    expect(result.targetAgentIds).toEqual(["a1", "a2"]);
  });

  it("routes to mentioned agent by id", () => {
    const result = routeMessage("@a1 help", session, agents);
    expect(result.targetAgentIds).toEqual(["a1"]);
  });

  it("routes to mentioned agent by name", () => {
    const result = routeMessage("@Bob help", session, agents);
    expect(result.targetAgentIds).toEqual(["a2"]);
  });
});
