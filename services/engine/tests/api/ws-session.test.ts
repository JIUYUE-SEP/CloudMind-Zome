import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
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
import { getDataDir } from "../../src/config/paths.js";
import type { Tool, ToolContext, ToolResult } from "../../src/tools/types.js";
import WebSocket from "ws";

async function buildSessionWsContext(agentIds: string[], tools: Tool[] = []): Promise<{ context: ApiContext; cleanup: () => Promise<void>; sessionId: string; providers: Map<string, MockLLMProvider> }> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ws-session-test-"));
  const originalDataDir = process.env.CLOUDMIND_DATA_DIR;
  process.env.CLOUDMIND_DATA_DIR = tmpDir;

  const agentRepository = new AgentRepository();
  const workers = new Map<string, AgentWorker>();
  const providers = new Map<string, MockLLMProvider>();
  for (const agentId of agentIds) {
    await agentRepository.save(agentId, {
      id: agentId,
      name: `Agent ${agentId}`,
      persona: "",
      model: "mock",
      skills: [],
      tools: tools.map((t) => t.name),
    });
    const provider = new MockLLMProvider();
    providers.set(agentId, provider);
    workers.set(
      agentId,
      new AgentWorker({
        agentId,
        model: "mock",
        provider,
        tools,
        workspaceDir: tmpDir,
        messageRepository: { append: async () => {}, listBySession: async () => [] },
        requiresApproval: () => true,
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
      agentRepository.dispose();
      await fs.rm(tmpDir, { recursive: true, force: true });
      process.env.CLOUDMIND_DATA_DIR = originalDataDir;
    },
    sessionId: session.id,
    providers,
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

  it("rejects invalid mode", async () => {
    const { context, cleanup, sessionId } = await buildSessionWsContext(["a1"]);
    const app = await createServer(context);
    const address = await app.listen({ port: 0 });
    const port = Number(new URL(address).port);

    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/sessions/${sessionId}`);

    const messages: unknown[] = [];
    await new Promise<void>((resolve, reject) => {
      client.on("open", () => {
        client.send(JSON.stringify({ type: "session.set_mode", mode: "invalid" }));
      });
      client.on("message", (data) => {
        messages.push(JSON.parse(String(data)));
        client.close();
        resolve();
      });
      client.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 5000);
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ type: "error", error: "Invalid mode" });

    const session = await context.sessionRepository.get(sessionId);
    expect(session?.mode).toBeUndefined();

    await app.close();
    await cleanup();
  });

  it("rejects invalid project id", async () => {
    const { context, cleanup, sessionId } = await buildSessionWsContext(["a1"]);
    const app = await createServer(context);
    const address = await app.listen({ port: 0 });
    const port = Number(new URL(address).port);

    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/sessions/${sessionId}`);

    const messages: unknown[] = [];
    await new Promise<void>((resolve, reject) => {
      client.on("open", () => {
        client.send(JSON.stringify({ type: "session.set_mode", mode: "code", projectId: "../escape" }));
      });
      client.on("message", (data) => {
        messages.push(JSON.parse(String(data)));
        client.close();
        resolve();
      });
      client.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 5000);
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ type: "error", error: "Invalid project id" });

    const projectRoot = path.join(getDataDir(), "projects", "../escape");
    await expect(fs.stat(projectRoot)).rejects.toThrow();

    const session = await context.sessionRepository.get(sessionId);
    expect(session?.mode).toBeUndefined();
    expect(session?.projectId).toBeUndefined();

    await app.close();
    await cleanup();
  });

  it("does not use projectRoot in chat mode even when projectId is set", async () => {
    const capturedRoots: (string | undefined)[] = [];
    const rootCapturingTool: Tool = {
      name: "capture_root",
      description: "captures projectRoot",
      parameters: z.object({}),
      accesses: [{ resource: "file", action: "read" }],
      async execute(ctx: ToolContext): Promise<ToolResult> {
        capturedRoots.push(ctx.projectRoot);
        return { success: true, output: "captured" };
      },
    };

    const { context, cleanup, sessionId, providers } = await buildSessionWsContext(["a1"], [rootCapturingTool]);
    providers.get("a1")?.setNextToolCalls([{ toolCallId: "tc-1", name: "capture_root", arguments: {} }]);

    const app = await createServer(context);
    const address = await app.listen({ port: 0 });
    const port = Number(new URL(address).port);

    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/sessions/${sessionId}`);

    const messages: unknown[] = [];
    await new Promise<void>((resolve, reject) => {
      client.on("open", () => {
        client.send(JSON.stringify({ type: "session.set_mode", mode: "chat", projectId: "proj-chat" }));
      });
      client.on("message", (data) => {
        const message = JSON.parse(String(data));
        messages.push(message);
        if (message.type === "session.mode_changed") {
          client.send(JSON.stringify({ text: "run tool" }));
        }
        if (message.type === "step.end") {
          client.close();
          resolve();
        }
      });
      client.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 5000);
    });

    expect(messages.some((m) => (m as { type: string }).type === "session.mode_changed")).toBe(true);
    expect(capturedRoots).toContain(undefined);

    await app.close();
    await cleanup();
  });
});
