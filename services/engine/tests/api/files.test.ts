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
import { getAgentDir } from "../../src/config/paths.js";
import type { AgentConfig } from "@mindcloud/shared";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let context: ApiContext;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "api-files-test-"));
  const originalDataDir = process.env.CLOUDMIND_DATA_DIR;
  process.env.CLOUDMIND_DATA_DIR = tmpDir;
  context = {
    agentRepository: new AgentRepository(),
    getMessageRepository: (agentId: string) => new MessageRepository(agentId),
    getMemoryRepository: (agentId: string) => new MemoryRepository(agentId),
    getActionRepository: (agentId: string) => new ActionRepository(agentId),
    getLLMCallRepository: (agentId: string) => new LLMCallRepository(agentId),
    configRepository: new ConfigRepository(),
    sessionRepository: new SessionRepository(),
    blueprintRepository: new BlueprintRepository(),
    getAgentWorker: async () => undefined,
    mind: mindService,
  };
  cleanup = async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    restoreDataDir(originalDataDir);
  };
});

afterEach(async () => {
  await cleanup();
});

async function makeApp(): Promise<FastifyInstance> {
  const app = await createServer(context);
  await app.ready();
  return app;
}

async function seedAgent(id = "a1"): Promise<void> {
  await context.agentRepository.save(id, { id, name: id } as AgentConfig);
}

async function seedFile(rel: string, content: Buffer | string = PNG_BYTES): Promise<void> {
  const fullPath = path.join(getAgentDir("a1"), rel);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content);
}

/** superagent 默认不把 image/* 解析进 body：自定义 parse 收 Buffer（结构类型：兼容 superagent Response 流接口，避免直引传递依赖） */
function binaryParser(
  res: { on(event: "data", cb: (chunk: Buffer) => void): void; on(event: "end", cb: () => void): void },
  cb: (err: Error | null, body?: Buffer) => void,
) {
  const chunks: Buffer[] = [];
  res.on("data", (chunk: Buffer) => chunks.push(chunk));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
}

describe("GET /agents/:id/files/*（决策 7 文件服务最小面）", () => {
  it("路径穿越（.. 编码）：400", async () => {
    await seedAgent();
    const app = await makeApp();
    const res = await authedRequest(app.server).get("/agents/a1/files/..%2F..%2Fconfig.json");
    expect(res.status).toBe(400);
    expect(String(res.body.error ?? res.text)).toContain("traversal");
    await app.close();
  });

  it("幽灵 agent：404", async () => {
    const app = await makeApp();
    const res = await authedRequest(app.server).get("/agents/ghost/files/images/x.png");
    expect(res.status).toBe(404);
    expect(String(res.body.error ?? res.text)).toContain("Agent not found");
    await app.close();
  });

  it("文件不存在：404", async () => {
    await seedAgent();
    const app = await makeApp();
    const res = await authedRequest(app.server).get("/agents/a1/files/images/missing.png");
    expect(res.status).toBe(404);
    expect(String(res.body.error ?? res.text)).toContain("File not found");
    await app.close();
  });

  it("目录请求：400（不列目录）", async () => {
    await seedAgent();
    await seedFile("files/images/keep.png");
    const app = await makeApp();
    const res = await authedRequest(app.server).get("/agents/a1/files/images");
    expect(res.status).toBe(400);
    expect(String(res.body.error ?? res.text)).toContain("Directory");
    await app.close();
  });

  it("扩展名不在白名单：415", async () => {
    await seedAgent();
    await seedFile("files/notes.txt", "hello");
    const app = await makeApp();
    const res = await authedRequest(app.server).get("/agents/a1/files/notes.txt");
    expect(res.status).toBe(415);
    await app.close();
  });

  it("正常 png：200 + content-type image/png + 字节一致 + content-length", async () => {
    await seedAgent();
    await seedFile("files/images/pic.png");
    const app = await makeApp();
    const res = await authedRequest(app.server)
      .get("/agents/a1/files/images/pic.png")
      .buffer(true)
      .parse(binaryParser);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("image/png");
    expect(res.headers["content-length"]).toBe(String(PNG_BYTES.byteLength));
    expect((res.body as Buffer).equals(PNG_BYTES)).toBe(true);
    await app.close();
  });

  it("jpg/jpeg 均映射 image/jpeg；webp/gif 各自映射", async () => {
    await seedAgent();
    await seedFile("files/images/a.jpg");
    await seedFile("files/images/b.jpeg");
    await seedFile("files/images/c.webp");
    await seedFile("files/images/d.gif");
    const app = await makeApp();
    for (const [file, mime] of [
      ["a.jpg", "image/jpeg"],
      ["b.jpeg", "image/jpeg"],
      ["c.webp", "image/webp"],
      ["d.gif", "image/gif"],
    ] as const) {
      const res = await authedRequest(app.server).get(`/agents/a1/files/images/${file}`);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain(mime);
    }
    await app.close();
  });
});
