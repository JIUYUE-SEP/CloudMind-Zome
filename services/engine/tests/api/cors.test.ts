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
import type { FastifyInstance } from "fastify";
import { restoreDataDir } from "../helpers/env.js";

describe("CORS", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cors-test-"));
    originalDataDir = process.env.CLOUDMIND_DATA_DIR;
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
    app = await createServer(context);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
    restoreDataDir(originalDataDir);
  });

  // 前端 PUT/DELETE 会触发浏览器预检；@fastify/cors v11 默认 methods 只有
  // CORS 安全方法（GET/HEAD/POST），不显式放开会被浏览器拦成 "Failed to fetch"
  it("preflight allows PUT and DELETE for allowed origin", async () => {
    for (const method of ["PUT", "DELETE"]) {
      const res = await authedRequest(app.server)
        .options("/agents/some-agent")
        .set("Origin", "http://localhost:3000")
        .set("Access-Control-Request-Method", method)
        .set("Access-Control-Request-Headers", "content-type");
      expect(res.status).toBe(204);
      expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
      expect(res.headers["access-control-allow-methods"]).toContain(method);
    }
  });

  it("preflight does not allow disallowed origin", async () => {
    const res = await authedRequest(app.server)
      .options("/agents/some-agent")
      .set("Origin", "http://evil.example.com")
      .set("Access-Control-Request-Method", "PUT");
    expect(res.headers["access-control-allow-origin"]).not.toBe("http://evil.example.com");
  });

  // F9：打包桌面端 webview 起源（tauri:// 自定义协议 / tauri.localhost 保留域）
  // 与 WS 握手同源放行——带 Bearer 头的 REST 预检不再被白名单拦死
  it("preflight allows Tauri webview origins (F9)", async () => {
    for (const origin of ["tauri://localhost", "https://tauri.localhost", "http://tauri.localhost"]) {
      const res = await authedRequest(app.server)
        .options("/agents/some-agent")
        .set("Origin", origin)
        .set("Access-Control-Request-Method", "PUT")
        .set("Access-Control-Request-Headers", "authorization,content-type");
      expect(res.status).toBe(204);
      expect(res.headers["access-control-allow-origin"]).toBe(origin);
      expect(res.headers["access-control-allow-methods"]).toContain("PUT");
    }
  });

  it("simple request from Tauri origin carries allow-origin header (F9)", async () => {
    const res = await authedRequest(app.server)
      .get("/health")
      .set("Origin", "tauri://localhost");
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("tauri://localhost");
  });
});
