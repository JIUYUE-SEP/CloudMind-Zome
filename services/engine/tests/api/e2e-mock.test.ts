import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { authedRequest } from "../helpers/auth.js";
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
import type { ApiContext } from "../../src/api/context.js";
import { mindService } from "../../src/plugins/mind/index.js";
import type { FastifyInstance } from "fastify";
import { restoreDataDir } from "../helpers/env.js";
import { MockLLMProvider } from "../../src/provider/llm.js";
import { ResilientLLMProvider } from "../../src/provider/resilient.js";
import { withLLMCallRecording } from "../../src/plugins/llm/record-calls.js";
import type { AgentConfig } from "@cloudmind/shared";
import type { AgentWorker } from "../../src/core/agent-worker.js";

const originalNodeEnv = process.env.NODE_ENV;

let tmpDir: string;
let context: ApiContext;
let cleanup: () => Promise<void>;
let mockProvider: MockLLMProvider;

function workerWith(provider: unknown): AgentWorker {
  return { config: { provider } } as unknown as AgentWorker;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "api-e2e-mock-"));
  const originalDataDir = process.env.CLOUDMIND_DATA_DIR;
  process.env.CLOUDMIND_DATA_DIR = tmpDir;
  const agentRepository = new AgentRepository();
  mockProvider = new MockLLMProvider();
  context = {
    agentRepository,
    getMessageRepository: (agentId: string) => new MessageRepository(agentId),
    getMemoryRepository: (agentId: string) => new MemoryRepository(agentId),
    getActionRepository: (agentId: string) => new ActionRepository(agentId),
    getLLMCallRepository: (agentId: string) => new LLMCallRepository(agentId),
    configRepository: new ConfigRepository(),
    sessionRepository: new SessionRepository(),
    blueprintRepository: new BlueprintRepository(),
    getAgentWorker: async () => workerWith(mockProvider),
    mind: mindService,
  };
  cleanup = async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    restoreDataDir(originalDataDir);
  };
  await agentRepository.save("e2e-agent", { id: "e2e-agent", name: "e2e-agent" } as AgentConfig);
});

afterEach(async () => {
  process.env.NODE_ENV = originalNodeEnv;
  await cleanup();
});

async function makeApp(): Promise<FastifyInstance> {
  const app = await createServer(context);
  await app.ready();
  return app;
}

describe("e2e 注入端点（决策 1：仅 NODE_ENV=e2e 注册）", () => {
  it("非 e2e 环境：路由零注册 404（生产零存在面）", async () => {
    process.env.NODE_ENV = "production";
    const app = await makeApp();
    const res = await authedRequest(app.server)
      .post("/e2e/mock/tool-calls")
      .send({ agentId: "e2e-agent", toolCalls: [{ toolCallId: "t1", name: "run_command", arguments: {} }] });
    expect(res.status).toBe(404);
    await app.close();
  });

  it("e2e 环境：注入成功，下一次 chat 发出注入的 tool call", async () => {
    process.env.NODE_ENV = "e2e";
    const app = await makeApp();
    const res = await authedRequest(app.server)
      .post("/e2e/mock/tool-calls")
      .send({ agentId: "e2e-agent", toolCalls: [{ toolCallId: "t1", name: "run_command", arguments: { command: "echo hi" } }] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, count: 1 });

    // 生产语义核验：Mock 的下一次 chat 真的发出该 tool.call 帧
    const events = [];
    for await (const ev of mockProvider.chat({ model: "m", messages: [] })) events.push(ev);
    expect(events[0]).toMatchObject({ type: "tool.call", toolCallId: "t1", name: "run_command" });
    await app.close();
  });

  it("包装链钻取（生产真形状 Resilient(record(Mock))）：照样命中", async () => {
    process.env.NODE_ENV = "e2e";
    const inner = new MockLLMProvider();
    const wrapped = new ResilientLLMProvider(
      withLLMCallRecording(inner, { append: async () => {} }, "e2e-agent"),
    );
    context.getAgentWorker = async () => workerWith(wrapped);
    const app = await makeApp();
    const res = await authedRequest(app.server)
      .post("/e2e/mock/tool-calls")
      .send({ agentId: "e2e-agent", toolCalls: [{ toolCallId: "t9", name: "generate_image", arguments: { prompt: "p" } }] });
    expect(res.status).toBe(200);

    const events = [];
    for await (const ev of inner.chat({ model: "m", messages: [] })) events.push(ev);
    expect(events[0]).toMatchObject({ type: "tool.call", toolCallId: "t9" });
    await app.close();
  });

  it("非 Mock provider：fail-closed 409 明确错误，不静默", async () => {
    process.env.NODE_ENV = "e2e";
    context.getAgentWorker = async () => workerWith({ name: "real-provider" });
    const app = await makeApp();
    const res = await authedRequest(app.server)
      .post("/e2e/mock/tool-calls")
      .send({ agentId: "e2e-agent", toolCalls: [{ toolCallId: "t1", name: "x", arguments: {} }] });
    expect(res.status).toBe(409);
    expect(String(res.body.error)).toContain("不是 MockLLMProvider");
    await app.close();
  });

  it("幽灵 agent 404 / zod 边界 400", async () => {
    process.env.NODE_ENV = "e2e";
    context.getAgentWorker = async () => undefined;
    const app = await makeApp();
    const ghost = await authedRequest(app.server)
      .post("/e2e/mock/tool-calls")
      .send({ agentId: "ghost", toolCalls: [{ toolCallId: "t1", name: "x", arguments: {} }] });
    expect(ghost.status).toBe(404);

    const bad = await authedRequest(app.server).post("/e2e/mock/tool-calls").send({ agentId: "e2e-agent" });
    expect(bad.status).toBe(400);
    await app.close();
  });
});
