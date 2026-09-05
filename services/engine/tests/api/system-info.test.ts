import { describe, it, expect, afterEach } from "vitest";
import { authedRequest } from "../helpers/auth.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
import type { SidecarClient } from "../../src/sidecar/client.js";
import { DEFAULT_ENGINE_PORT } from "@cloudmind/shared";
import { restoreDataDir } from "../helpers/env.js";

// 与 src/api/routes/system.ts 向上查找同一口径读真实版本（测试文件起自 tests/api/）
const pkg = JSON.parse(
  await fs.readFile(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../../package.json"),
    "utf-8",
  ),
) as { version: string };

async function buildTestContext(
  withSidecar = false,
): Promise<{ context: ApiContext; tmpDir: string; cleanup: () => Promise<void> }> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "system-info-api-test-"));
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
    // configured 只判定客户端是否存在，假对象即可（不触发任何 gRPC 行为）
    ...(withSidecar ? { sidecarClient: {} as SidecarClient } : {}),
  };

  return {
    context,
    tmpDir,
    cleanup: async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
      restoreDataDir(originalDataDir);
    },
  };
}

describe("System Info API", () => {
  let cleanup: () => Promise<void>;

  afterEach(async () => {
    await cleanup();
  });

  it("GET /system/info 返回版本/数据目录/端口/运行时长，sidecar 未装配时 configured=false", async () => {
    const built = await buildTestContext();
    cleanup = built.cleanup;
    const app = await createServer(built.context);
    await app.ready();

    const res = await authedRequest(app.server).get("/system/info");
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(pkg.version);
    // gitCommit 可选：在 git 仓库内运行为短哈希字符串，打包环境省略该字段
    if ("gitCommit" in res.body) {
      expect(typeof res.body.gitCommit).toBe("string");
    }
    expect(res.body.dataDir).toBe(built.tmpDir);
    expect(res.body.port).toBe(DEFAULT_ENGINE_PORT);
    expect(typeof res.body.uptimeSec).toBe("number");
    expect(res.body.uptimeSec).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(res.body.uptimeSec)).toBe(true);
    expect(res.body.sidecar).toEqual({ configured: false });
    await app.close();
  });

  it("GET /system/info 在 sidecarClient 装配时 configured=true", async () => {
    const built = await buildTestContext(true);
    cleanup = built.cleanup;
    const app = await createServer(built.context);
    await app.ready();

    const res = await authedRequest(app.server).get("/system/info");
    expect(res.status).toBe(200);
    expect(res.body.sidecar).toEqual({ configured: true });
    await app.close();
  });
});
