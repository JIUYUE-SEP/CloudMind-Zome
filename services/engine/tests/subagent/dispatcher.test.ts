import { describe, it, expect, vi } from "vitest";
import { SubagentDispatcher } from "../../src/subagent/dispatcher.js";
import { BackgroundManager } from "../../src/subagent/background.js";
import type { AgentConfig } from "@mindcloud/shared";

const config: AgentConfig = { id: "a2", name: "A2", persona: "", model: "mock", skills: [], tools: [] };

describe("SubagentDispatcher", () => {
  it("borrows agent config and runs foreground", async () => {
    const dispatcher = new SubagentDispatcher({
      getAgentConfig: async () => config,
      runAgent: async () => "ok",
    });
    const result = await dispatcher.dispatch("a1", "a2", "do work", { mode: "foreground" });
    expect(result).toMatchObject({ output: "ok" });
    expect((result as { error?: string }).error).toBeUndefined();
  });

  it("rejects dispatching to itself", async () => {
    const dispatcher = new SubagentDispatcher({
      getAgentConfig: async () => config,
      runAgent: async () => "ok",
    });
    await expect(dispatcher.dispatch("a2", "a2", "do work", { mode: "foreground" })).rejects.toThrow(
      "cannot dispatch to itself"
    );
  });

  it("rejects unknown agent", async () => {
    const dispatcher = new SubagentDispatcher({
      getAgentConfig: async () => undefined,
      runAgent: async () => "ok",
    });
    await expect(dispatcher.dispatch("a1", "ghost", "do work", { mode: "foreground" })).rejects.toThrow(
      "Agent ghost not found"
    );
  });

  it("returns timeout error when foreground run exceeds timeout", async () => {
    const dispatcher = new SubagentDispatcher({
      getAgentConfig: async () => config,
      runAgent: () => new Promise(() => {}),
    });
    const result = await dispatcher.dispatch("a1", "a2", "do work", { mode: "foreground", timeoutMs: 20 });
    expect(result).toMatchObject({ output: "", error: "timeout" });
  });

  it("aborts the underlying run when foreground run times out", async () => {
    let receivedSignal: AbortSignal | undefined;
    const dispatcher = new SubagentDispatcher({
      getAgentConfig: async () => config,
      runAgent: (_id, _messages, opts) => {
        receivedSignal = opts?.signal;
        return new Promise(() => {});
      },
    });
    const result = await dispatcher.dispatch("a1", "a2", "do work", { mode: "foreground", timeoutMs: 20 });
    expect(result).toMatchObject({ output: "", error: "timeout" });
    // 超时后必须真正中止 worker 里仍在跑的任务，而不是只放弃等待
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("aborts the underlying run when background task times out", async () => {
    let receivedSignal: AbortSignal | undefined;
    const background = new BackgroundManager({
      runAgent: (_id, _messages, opts) => {
        receivedSignal = opts?.signal;
        return new Promise(() => {});
      },
    });
    const dispatcher = new SubagentDispatcher({
      getAgentConfig: async () => config,
      runAgent: async () => "ok",
      background,
    });
    const taskId = (await dispatcher.dispatch("a1", "a2", "do work", {
      mode: "background",
      timeoutMs: 20,
    })) as string;
    await vi.waitFor(() => expect(background.get(taskId)?.status).toBe("failed"));
    expect(background.get(taskId)?.error).toContain("timeout");
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("registers background task and returns task id", async () => {
    const background = new BackgroundManager({ runAgent: async () => "ok" });
    const dispatcher = new SubagentDispatcher({
      getAgentConfig: async () => config,
      runAgent: async () => "ok",
      background,
    });
    const result = await dispatcher.dispatch("a1", "a2", "do work", { mode: "background" });
    expect(typeof result).toBe("string");
    const bg = background.get(result as string);
    expect(bg).toBeDefined();
    expect(bg?.task.taskDescription).toBe("do work");
  });

  it("marks background task completed with final output", async () => {
    const background = new BackgroundManager({ runAgent: async () => "final text" });
    const dispatcher = new SubagentDispatcher({
      getAgentConfig: async () => config,
      runAgent: async () => "final text",
      background,
    });
    const taskId = (await dispatcher.dispatch("a1", "a2", "do work", { mode: "background" })) as string;
    await vi.waitFor(() => expect(background.get(taskId)?.status).toBe("completed"));
    expect(background.get(taskId)?.output).toBe("final text");
  });

  it("marks background task failed when runAgent rejects", async () => {
    const background = new BackgroundManager({
      runAgent: async () => {
        throw new Error("boom");
      },
    });
    const dispatcher = new SubagentDispatcher({
      getAgentConfig: async () => config,
      runAgent: async () => "ok",
      background,
    });
    const taskId = (await dispatcher.dispatch("a1", "a2", "do work", { mode: "background" })) as string;
    await vi.waitFor(() => expect(background.get(taskId)?.status).toBe("failed"));
    expect(background.get(taskId)?.error).toContain("boom");
  });
});
