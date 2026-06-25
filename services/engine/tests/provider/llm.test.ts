import { describe, it, expect } from "vitest";
import { MockLLMProvider, OpenAIProvider } from "../../src/provider/llm.js";
import type { LLMEvent } from "../../src/provider/types.js";

function makeChunk(delta: unknown) {
  return { choices: [{ delta }] };
}

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

describe("OpenAIProvider", () => {
  it("aggregates multiple streaming tool calls by index", async () => {
    const provider = new OpenAIProvider("test-key");

    async function* mockStream() {
      yield makeChunk({ content: "Planning" });
      yield makeChunk({
        tool_calls: [{ index: 0, id: "call_1", function: { name: "get_weather" } }],
      });
      yield makeChunk({
        tool_calls: [{ index: 0, function: { arguments: '{"loc' } }],
      });
      yield makeChunk({
        tool_calls: [{ index: 0, function: { arguments: 'ation":"NYC"}' } }],
      });
      yield makeChunk({
        tool_calls: [{ index: 1, id: "call_2", function: { name: "get_time" } }],
      });
      yield makeChunk({
        tool_calls: [{ index: 1, function: { arguments: '{"tz":"UTC"}' } }],
      });
      yield makeChunk({});
    }

    (provider as unknown as { client: { chat: { completions: { create: typeof mockStream } } } }).client = {
      chat: {
        completions: {
          create: mockStream,
        },
      },
    };

    const events: LLMEvent[] = [];
    for await (const event of provider.chat({ model: "gpt-4", messages: [] })) {
      events.push(event);
    }

    const toolCalls = events.filter((e): e is LLMEvent & { type: "tool.call" } => e.type === "tool.call");
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]).toEqual({
      type: "tool.call",
      toolCallId: "call_1",
      name: "get_weather",
      arguments: { location: "NYC" },
    });
    expect(toolCalls[1]).toEqual({
      type: "tool.call",
      toolCallId: "call_2",
      name: "get_time",
      arguments: { tz: "UTC" },
    });
    expect(events.at(-1)).toEqual({ type: "step.end" });
  });
});
