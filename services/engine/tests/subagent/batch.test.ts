import { describe, it, expect } from "vitest";
import { SubagentBatch } from "../../src/subagent/batch.js";
import type { SubagentResult } from "../../src/subagent/types.js";

describe("SubagentBatch", () => {
  it("dispatches inputs in parallel and preserves order", async () => {
    const outputs = ["a", "b", "c"];
    const batch = new SubagentBatch(async (input: string) => {
      return { taskId: input, messages: [] } satisfies SubagentResult;
    });
    const results = await batch.run(outputs, { concurrency: 2 });
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.taskId)).toEqual(outputs);
  });

  it("retries failed dispatches", async () => {
    let attempts = 0;
    const batch = new SubagentBatch(async () => {
      attempts += 1;
      if (attempts < 2) {
        throw new Error("transient");
      }
      return { taskId: "ok", messages: [] };
    });
    const results = await batch.run(["x"], { retry: 2 });
    expect(results[0].error).toBeUndefined();
    expect(results[0].taskId).toBe("ok");
  });
});
