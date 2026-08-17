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

  it("routes @all to every agent in the session", () => {
    const result = routeMessage("@all 开会", session, agents);
    expect(result.targetAgentIds).toEqual(["a1", "a2"]);
    expect(result.mentionAll).toBe(true);
  });

  it("routes @所有人 to every agent in the session", () => {
    const result = routeMessage("@所有人 开会", session, agents);
    expect(result.targetAgentIds).toEqual(["a1", "a2"]);
    expect(result.mentionAll).toBe(true);
  });

  it("returns empty targets for unresolvable mentions (handler must surface an error)", () => {
    const result = routeMessage("@nobody help", session, agents);
    expect(result.targetAgentIds).toEqual([]);
    expect(result.mentionAll).toBe(false);
  });

  it("M30：重复 @mention 去重——同一 agent 只入队回复一次", () => {
    expect(routeMessage("@a1 @a1 help", session, agents).targetAgentIds).toEqual(["a1"]);
    // id 与 name 混写命中同一 agent 同样去重
    expect(routeMessage("@Alice @a1 help", session, agents).targetAgentIds).toEqual(["a1"]);
    // 多个不同 agent 的 mention 保持各自一次、顺序不变
    expect(routeMessage("@a1 @Bob @a1 help", session, agents).targetAgentIds).toEqual(["a1", "a2"]);
  });
});
