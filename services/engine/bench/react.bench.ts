import { bench, describe } from "vitest";
import { runTurn } from "../src/core/react/turn.js";
import { MockLLMProvider } from "../src/provider/llm.js";

describe("ReActLoop", () => {
  bench("runTurn with mock provider", async () => {
    await runTurn(
      {
        messages: [
          {
            id: "1",
            role: "user",
            content: [{ type: "text", text: "hi" }],
            createdAt: "2024-01-01T00:00:00.000Z",
          },
        ],
        model: "mock",
        provider: new MockLLMProvider(),
        tools: [],
        toolCtx: {
          agentId: "bench",
          workspaceDir: ".",
          tools: new Map(),
          requiresApproval: () => false,
          emit: () => {},
        },
        maxSteps: 3,
      },
      () => {}
    );
  });
});
