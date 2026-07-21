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
import { restoreDataDir } from "../helpers/env.js";

async function buildWsContext(agentId: string): Promise<{ context: ApiContext; cleanup: () => Promise<void> }> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ws-test-"));
  const originalDataDir = process.env.CLOUDMIND_DATA_DIR;
  process.env.CLOUDMIND_DATA_DIR = tmpDir;

  const agentRepository = new AgentRepository();
  await agentRepository.save(agentId, {
    id: agentId,
    name: "Test",
    persona: "",
    model: "mock",
    skills: [],
    tools: [],
  });

  const worker = new AgentWorker({
    agentId,
    model: "mock",
    provider: new MockLLMProvider(),
    tools: [],
    workspaceDir: tmpDir,
    messageRepository: {
      append: async () => {},
      listBySession: async () => [],
      getByIds: async () => [],
      archiveAndRemove: async () => {},
      getArchivedByIds: async () => [],
    },
    approve: () => true,
  });

  const context: ApiContext = {
    agentRepository,
    getMessageRepository: (id: string) => new MessageRepository(id),
    getMemoryRepository: (id: string) => new MemoryRepository(id),
    getActionRepository: (id: string) => new ActionRepository(id),
    getLLMCallRepository: (id: string) => new LLMCallRepository(id),
    configRepository: new ConfigRepository(),
    sessionRepository: new SessionRepository(),
    blueprintRepository: new BlueprintRepository(),
    getAgentWorker: async (id: string) => (id === agentId ? worker : undefined),
  };

  return {
    context,
    cleanup: async () => {
      agentRepository.dispose();
      await fs.rm(tmpDir, { recursive: true, force: true });
      restoreDataDir(originalDataDir);
    },
  };
}

describe("WebSocket API", () => {
  it("connects and receives assistant text", async () => {
    const { context, cleanup } = await buildWsContext("agent-ws");
    const app = await createServer(context);
    const address = await app.listen({ port: 0 });
    const port = Number(new URL(address).port);

    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/agent-ws?sessionId=s1`);

    const messages: unknown[] = [];
    await new Promise<void>((resolve, reject) => {
      client.on("open", () => {
        client.send(JSON.stringify({ text: "hello" }));
      });
      client.on("message", (data) => {
        messages.push(JSON.parse(String(data)));
        if (messages.length >= 2) {
          client.close();
          resolve();
        }
      });
      client.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 5000);
    });

    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages.some((m) => (m as { type: string }).type === "text.delta")).toBe(true);
    await app.close();
    await cleanup();
  });

  it("silently ignores unknown control frames instead of erroring", async () => {
    const { context, cleanup } = await buildWsContext("agent-ws");
    const app = await createServer(context);
    const address = await app.listen({ port: 0 });
    const port = Number(new URL(address).port);

    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/agent-ws?sessionId=s1`);

    const messages: unknown[] = [];
    await new Promise<void>((resolve, reject) => {
      client.on("open", async () => {
        // 未知控制帧（前端协议超前/遗留帧）：应静默忽略，不回错误
        client.send(JSON.stringify({ type: "code.file_open", path: "src/a.ts" }));
        await new Promise((r) => setTimeout(r, 300));
        // 随后的正常聊天消息仍应被处理
        client.send(JSON.stringify({ text: "hello" }));
      });
      client.on("message", (data) => {
        const message = JSON.parse(String(data));
        messages.push(message);
        if (message.type === "step.end") {
          client.close();
          resolve();
        }
      });
      client.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 5000);
    });

    expect(messages.some((m) => (m as { type: string }).type === "error")).toBe(false);
    expect(messages.some((m) => (m as { type: string }).type === "text.delta")).toBe(true);
    await app.close();
    await cleanup();
  });
});
