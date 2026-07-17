import { describe, it, expect } from "vitest";
import { dispatchSubagentTool } from "../../src/tools/builtin/dispatch_subagent.js";
import { SubagentDispatcher } from "../../src/subagent/dispatcher.js";
import { BackgroundManager } from "../../src/subagent/background.js";
import type { ToolContext } from "../../src/tools/types.js";
import type { AgentConfig } from "@mindcloud/shared";

const borrowedConfig: AgentConfig = {
  id: "a2",
  name: "A2",
  persona: "",
  model: "mock",
  skills: [],
  tools: [],
};

function makeCtx(dispatcher?: SubagentDispatcher): ToolContext {
  return {
    agentId: "a1",
    workspaceDir: "/tmp",
    approve: () => true,
    services: dispatcher ? { subagentDispatcher: dispatcher } : {},
  };
}

function makeDispatcher(runAgent: (agentId: string) => Promise<string> = async () => "sub result") {
  return new SubagentDispatcher({
    getAgentConfig: async (id) => (id === "a2" ? borrowedConfig : undefined),
    runAgent,
    background: new BackgroundManager({ runAgent }),
  });
}

describe("dispatch_subagent tool", () => {
  it("runs foreground and returns the sub-agent final text", async () => {
    const result = await dispatchSubagentTool.execute(makeCtx(makeDispatcher()), {
      agentId: "a2",
      task: "summarize this",
    });
    expect(result.success).toBe(true);
    expect((result.output as { output: string }).output).toBe("sub result");
    expect((result.output as { taskId: string }).taskId).toBeTruthy();
  });

  it("rejects dispatching to itself", async () => {
    const result = await dispatchSubagentTool.execute(makeCtx(makeDispatcher()), {
      agentId: "a1",
      task: "loop",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("cannot dispatch to itself");
  });

  it("rejects unknown agent", async () => {
    const result = await dispatchSubagentTool.execute(makeCtx(makeDispatcher()), {
      agentId: "ghost",
      task: "hi",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Agent ghost not found");
  });

  it("returns taskId immediately in background mode", async () => {
    const result = await dispatchSubagentTool.execute(makeCtx(makeDispatcher()), {
      agentId: "a2",
      task: "slow job",
      mode: "background",
    });
    expect(result.success).toBe(true);
    expect((result.output as { taskId: string }).taskId).toBeTruthy();
  });

  it("fails when dispatcher is not available in context", async () => {
    const result = await dispatchSubagentTool.execute(makeCtx(), {
      agentId: "a2",
      task: "hi",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not available");
  });
});
