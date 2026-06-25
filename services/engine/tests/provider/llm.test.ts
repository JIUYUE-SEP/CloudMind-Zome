import { describe, it, expect } from "vitest";
import { MockLLMProvider } from "../../src/provider/llm.js";
import type { LLMEvent } from "../../src/provider/types.js";

describe("MockLLMProvider", () => {
  it("yields text.delta and step.end events", async () => {
    const provider = new MockLLMProvider();
    const events: LLMEvent[] = [];
    for await (const event of provider.chat({ model: "mock", messages: [] })) {
      events.push(event);
    }

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "text.delta", delta: "Hello from mock" });
    expect(events[1]).toEqual({ type: "step.end" });
  });

  it("supports any model", () => {
    const provider = new MockLLMProvider();
    expect(provider.supportsModel("anything")).toBe(true);
  });
});
