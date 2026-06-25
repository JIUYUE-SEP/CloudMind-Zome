import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "../../src/api/server.js";
import { AgentRepository } from "../../src/memory/repositories/agent.js";
import { MessageRepository } from "../../src/memory/repositories/message.js";
import { MemoryRepository } from "../../src/memory/repositories/memory.js";
import { ActionRepository } from "../../src/memory/repositories/action.js";
import { LLMCallRepository } from "../../src/memory/repositories/llm-call.js";
import { ConfigRepository } from "../../src/config/repository.js";
import { SessionRepository } from "../../src/conductor/repository.js";
import { BlueprintRepository } from "../../src/blueprint/repository.js";
import { AgentWorker } from "../../src/core/agent-worker.js";
import { MockLLMProvider } from "../../src/provider/llm.js";
import type { ApiContext } from "../../src/api/context.js";
import WebSocket from "ws";

async function buildSessionWsContext(agentIds: string[]): Promise<{ context: ApiContext; cleanup: () => Promise<void>; sessionId: string }> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ws-session-test-"));
  const originalDataDir = process.env.CLOUDMIND_DATA_DIR;
  process.env.CLOUDMIND_DATA_DIR = tmpDir;

  const agentRepository = new AgentRepository();
  const workers = new Map<string, AgentWorker>();
  for (const agentId of agentIds) {
    await agentRepository.save(agentId, {
      id: agentId,
      name: `Agent ${agentId}`,
      persona: "",
      model: "mock",
      skills: [],
      tools: [],
    });
    workers.set(
      agentId,
      new AgentWorker({
        agentId,
        model: "mock",
        provider: new MockLLMProvider(),
        tools: [],
        workspaceDir: tmpDir,
        requiresApproval: () => false,
      })
    );
  }

  const sessionRepository = new SessionRepository();
  const session = await sessionRepository.create({
    name: "Test Group",
    agentIds,
    type: "group",
  });

  const context: ApiContext = {
    agentRepository,
    getMessageRepository: (id: string) => new MessageRepository(id),
    getMemoryRepository: (id: string) => new MemoryRepository(id),
    getActionRepository: (id: string) => new ActionRepository(id),
    getLLMCallRepository: (id: string) => new LLMCallRepository(id),
    configRepository: new ConfigRepository(),
    sessionRepository,
    blueprintRepository: new BlueprintRepository(),
    getAgentWorker: async (id: string) => workers.get(id),
  };

  return {
    context,
    cleanup: async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
      process.env.CLOUDMIND_DATA_DIR = originalDataDir;
    },
    sessionId: session.id,
  };
}

describe("Session WebSocket API", () => {
  it("routes user message to all agents and receives replies", async () => {
    const { context, cleanup, sessionId } = await buildSessionWsContext(["a1", "a2"]);
    const app = await createServer(context);
    const address = await app.listen({ port: 0 });
    const port = Number(new URL(address).port);

    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/sessions/${sessionId}`);

    const messages: unknown[] = [];
    await new Promise<void>((resolve, reject) => {
      client.on("open", () => {
        client.send(JSON.stringify({ text: "hello everyone" }));
      });
      client.on("message", (data) => {
        messages.push(JSON.parse(String(data)));
        // Each agent emits text.delta + step.end; wait for both agents.
        const stepEnds = messages.filter((m) => (m as { type: string }).type === "step.end");
        if (stepEnds.length >= 2) {
          client.close();
          resolve();
        }
      });
      client.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 5000);
    });

    const agentIds = messages
      .filter((m) => (m as { type: string }).type === "text.delta")
      .map((m) => (m as { agentId: string }).agentId);
    expect(agentIds).toContain("a1");
    expect(agentIds).toContain("a2");

    await app.close();
    await cleanup();
  });

  it("routes user message to mentioned agent only", async () => {
    const { context, cleanup, sessionId } = await buildSessionWsContext(["a1", "a2"]);
    const app = await createServer(context);
    const address = await app.listen({ port: 0 });
    const port = Number(new URL(address).port);

    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/sessions/${sessionId}`);

    const messages: unknown[] = [];
    await new Promise<void>((resolve, reject) => {
      client.on("open", () => {
        client.send(JSON.stringify({ text: "@a1 private" }));
      });
      client.on("message", (data) => {
        messages.push(JSON.parse(String(data)));
        if (messages.length >= 1) {
          client.close();
          resolve();
        }
      });
      client.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 5000);
    });

    const agentIds = messages
      .filter((m) => (m as { type: string }).type === "text.delta")
      .map((m) => (m as { agentId: string }).agentId);
    expect(agentIds).toContain("a1");
    expect(agentIds).not.toContain("a2");

    await app.close();
    await cleanup();
  });
});
