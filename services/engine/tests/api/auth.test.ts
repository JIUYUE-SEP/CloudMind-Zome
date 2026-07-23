import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import WebSocket from "ws";
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
import type { FastifyInstance } from "fastify";
import { restoreDataDir } from "../helpers/env.js";
import { authedRequest, TEST_AUTH_TOKEN } from "../helpers/auth.js";

async function buildContext(): Promise<{ context: ApiContext; cleanup: () => Promise<void> }> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-api-test-"));
  const originalDataDir = process.env.CLOUDMIND_DATA_DIR;
  process.env.CLOUDMIND_DATA_DIR = tmpDir;

  const context: ApiContext = {
    agentRepository: new AgentRepository(),
    getMessageRepository: (agentId: string) => new MessageRepository(agentId),
    getMemoryRepository: (agentId: string) => new MemoryRepository(agentId),
    getActionRepository: (agentId: string) => new ActionRepository(agentId),
    getLLMCallRepository: (agentId: string) => new LLMCallRepository(agentId),
    configRepository: new ConfigRepository(),
    sessionRepository: new SessionRepository(),
    blueprintRepository: new BlueprintRepository(),
    getAgentWorker: async () => undefined,
  };

  return {
    context,
    cleanup: async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
      restoreDataDir(originalDataDir);
    },
  };
}

/** 连接并等待服务端关闭帧，返回 close code（鉴权失败 4401 / agent 不存在 4001 等） */
function wsCloseCode(url: string, protocols?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const client = protocols ? new WebSocket(url, protocols) : new WebSocket(url);
    client.on("close", (code) => resolve(code));
    client.on("error", reject);
  });
}

describe("本地 token 鉴权（P0-2）", () => {
  let app: FastifyInstance;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const built = await buildContext();
    cleanup = built.cleanup;
    app = await createServer(built.context);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await cleanup();
  });

  it("/health 免鉴权，供 sidecar/desktop 健康检查", async () => {
    const res = await request(app.server).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("REST 无 token 返回 401", async () => {
    const res = await request(app.server).get("/agents");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Unauthorized");
  });

  it("REST 错误 token 返回 401", async () => {
    const res = await request(app.server)
      .get("/agents")
      .set("Authorization", "Bearer wrong-token");
    expect(res.status).toBe(401);
  });

  it("REST 带正确 Bearer token 正常访问", async () => {
    const res = await authedRequest(app.server).get("/agents");
    expect(res.status).toBe(200);
  });

  it("WS 无 token 握手后即以 4401 拒连", async () => {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as { port: number };
    const code = await wsCloseCode(`ws://127.0.0.1:${port}/ws/agent-x?sessionId=s1`);
    expect(code).toBe(4401);
  });

  it("WS 错误 token 同样 4401 拒连", async () => {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as { port: number };
    const code = await wsCloseCode(`ws://127.0.0.1:${port}/ws/agent-x?sessionId=s1`, "wrong-token");
    expect(code).toBe(4401);
  });

  it("WS 正确 token 通过鉴权（agent 不存在走到业务关闭码 4001）", async () => {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as { port: number };
    const code = await wsCloseCode(`ws://127.0.0.1:${port}/ws/agent-x?sessionId=s1`, TEST_AUTH_TOKEN);
    expect(code).toBe(4001);
  });

  it("会话 WS 无 token 同样 4401 拒连", async () => {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as { port: number };
    const code = await wsCloseCode(`ws://127.0.0.1:${port}/ws/sessions/s1`);
    expect(code).toBe(4401);
  });
});
