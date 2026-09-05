import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { authedRequest } from "../helpers/auth.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "../../src/api/server.js";
import { AgentRepository } from "../../src/memory/repositories/agent.js";
import { MessageRepository } from "../../src/memory/repositories/message.js";
import { MemoryRepository } from "../../src/memory/repositories/memory.js";
import { ActionRepository } from "../../src/memory/repositories/action.js";
import { LLMCallRepository } from "../../src/memory/repositories/llm-call.js";
import { ConfigRepository } from "../../src/config/repository.js";
import { SessionRepository } from "../../src/conductor/repository.js";
import { BlueprintRepository } from "../../src/blueprint/repository.js";
import { BackgroundManager } from "../../src/subagent/background.js";
import { SubagentTaskRepository } from "../../src/subagent/task-repository.js";
import type { ApiContext } from "../../src/api/context.js";
import type { FastifyInstance } from "fastify";
import type { AgentConfig } from "@cloudmind/shared";
import { restoreDataDir } from "../helpers/env.js";
import { logger } from "../../src/logger.js";

const config: AgentConfig = { id: "a2", name: "A2", persona: "", model: "mock", skills: [], tools: [] };

async function buildContext(runAgent: () => Promise<string>): Promise<{
  context: ApiContext;
  backgroundManager: BackgroundManager;
  cleanup: () => Promise<void>;
}> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "subagents-api-test-"));
  const originalDataDir = process.env.CLOUDMIND_DATA_DIR;
  process.env.CLOUDMIND_DATA_DIR = tmpDir;

  const backgroundManager = new BackgroundManager(
    { runAgent },
    new SubagentTaskRepository(path.join(tmpDir, "subagent-tasks.jsonl")),
  );

  const context: ApiContext = {
    agentRepository: new AgentRepository(),
    getMessageRepository: (id: string) => new MessageRepository(id),
    getMemoryRepository: (id: string) => new MemoryRepository(id),
    getActionRepository: (id: string) => new ActionRepository(id),
    getLLMCallRepository: (id: string) => new LLMCallRepository(id),
    configRepository: new ConfigRepository(),
    sessionRepository: new SessionRepository(),
    blueprintRepository: new BlueprintRepository(),
    getAgentWorker: async () => undefined,
    backgroundManager,
  };

  return {
    context,
    backgroundManager,
    cleanup: async () => {
      // 任务状态翻转先于落盘 await 完成（run/runTracked 尾部），
      // rm 与在飞写撞车会 ENOTEMPTY——重试覆盖收尾窗口（与 ws.test 同范式）
      await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      restoreDataDir(originalDataDir);
    },
  };
}

function makeTask(id: string) {
  return {
    id,
    parentAgentId: "a1",
    taskDescription: "do work",
    messages: [
      {
        id: randomUUID(),
        role: "user" as const,
        content: [{ type: "text" as const, text: "do work" }],
        createdAt: new Date().toISOString(),
      },
    ],
  };
}

describe("Subagents API", () => {
  let app: FastifyInstance;
  let backgroundManager: BackgroundManager;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const built = await buildContext(async () => "bg result");
    backgroundManager = built.backgroundManager;
    cleanup = built.cleanup;
    app = await createServer(built.context);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await cleanup();
  });

  it("lists background tasks and gets one by id", async () => {
    backgroundManager.register(makeTask("t1"), config, 60_000);
    await vi.waitFor(() => expect(backgroundManager.get("t1")?.status).toBe("completed"));

    const list = await authedRequest(app.server).get("/subagents/background");
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ taskId: "t1", status: "completed", output: "bg result" });

    const got = await authedRequest(app.server).get("/subagents/background/t1");
    expect(got.status).toBe(200);
    expect(got.body.parentAgentId).toBe("a1");
    expect(got.body.agentId).toBe("a2");
  });

  it("returns 404 for unknown task id", async () => {
    const res = await authedRequest(app.server).get("/subagents/background/nope");
    expect(res.status).toBe(404);
  });

  it("resume：不存在 404、非 owner 404、running 409、终态恢复 running 且 attempts+1", async () => {
    // 终态任务 resume 成功
    backgroundManager.register(makeTask("t-resume"), config, 60_000);
    await vi.waitFor(() => expect(backgroundManager.get("t-resume")?.status).toBe("completed"));

    const notFound = await authedRequest(app.server).post("/agents/a1/subagents/nope/resume");
    expect(notFound.status).toBe(404);

    const notOwner = await authedRequest(app.server).post("/agents/other/subagents/t-resume/resume");
    expect(notOwner.status).toBe(404);

    const ok = await authedRequest(app.server).post("/agents/a1/subagents/t-resume/resume");
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ taskId: "t-resume", status: "running", attempts: 2 });
    await vi.waitFor(() => expect(backgroundManager.get("t-resume")?.status).toBe("completed"));
    expect(backgroundManager.get("t-resume")?.attempts).toBe(2);

    // running 任务 resume 拒绝 409
    await app.close();
    await cleanup();
    const built = await buildContext(() => new Promise<string>(() => {}));
    backgroundManager = built.backgroundManager;
    cleanup = built.cleanup;
    app = await createServer(built.context);
    await app.ready();
    backgroundManager.register(makeTask("t-busy"), config, 60_000);
    await vi.waitFor(() => expect(backgroundManager.get("t-busy")?.status).toBe("running"));

    const conflict = await authedRequest(app.server).post("/agents/a1/subagents/t-busy/resume");
    expect(conflict.status).toBe(409);
  });

  it("reflects failed status after runAgent rejects", async () => {
    await app.close();
    await cleanup();

    const built = await buildContext(async () => {
      throw new Error("bg boom");
    });
    backgroundManager = built.backgroundManager;
    cleanup = built.cleanup;
    app = await createServer(built.context);
    await app.ready();

    backgroundManager.register(makeTask("t2"), config, 60_000);
    await vi.waitFor(() => expect(backgroundManager.get("t2")?.status).toBe("failed"));

    const res = await authedRequest(app.server).get("/subagents/background/t2");
    expect(res.body.status).toBe("failed");
    expect(res.body.error).toContain("bg boom");
  });

  it("H-1：resume 重跑失败不崩进程——completion 被接住记 warn，响应正常", async () => {
    await app.close();
    await cleanup();

    // runAgent 恒失败：首次执行即落 failed，resume 重跑必然再次失败
    const built = await buildContext(async () => {
      throw new Error("resume boom");
    });
    backgroundManager = built.backgroundManager;
    cleanup = built.cleanup;
    app = await createServer(built.context);
    await app.ready();

    backgroundManager.register(makeTask("t-fail"), config, 60_000);
    await vi.waitFor(() => expect(backgroundManager.get("t-fail")?.status).toBe("failed"));

    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const res = await authedRequest(app.server).post("/agents/a1/subagents/t-fail/resume");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ taskId: "t-fail", status: "running", attempts: 2 });

      // 重跑再次失败：状态落 failed。completion 若没被 .catch 接住，Node 默认
      // throw 模式下这里会是 unhandled rejection 直接崩掉进程（vitest 判负）
      await vi.waitFor(() => expect(backgroundManager.get("t-fail")?.status).toBe("failed"));
      expect(backgroundManager.get("t-fail")?.attempts).toBe(2);
      await vi.waitFor(() => {
        const calls = warnSpy.mock.calls.filter((c) =>
          String(c[1]).includes("resume 重跑失败"),
        );
        expect(calls).toHaveLength(1);
        expect((calls[0]![0] as Record<string, unknown>).taskId).toBe("t-fail");
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("summary 暴露 kind（默认 delegate / 显式 puppet）", async () => {
    backgroundManager.register(makeTask("t-kind-1"), config, 60_000);
    backgroundManager.register(makeTask("t-kind-2"), config, 60_000, "puppet");
    await vi.waitFor(() => expect(backgroundManager.get("t-kind-2")?.status).toBe("completed"));

    const list = await authedRequest(app.server).get("/subagents/background");
    const byId = new Map(list.body.map((t: { taskId: string }) => [t.taskId, t]));
    expect(byId.get("t-kind-1")).toMatchObject({ kind: "delegate" });
    expect(byId.get("t-kind-2")).toMatchObject({ kind: "puppet" });
  });

  it("puppet 任务 REST 暴露：agentId=owner、kind=puppet", async () => {
    // dispatcher 对 puppet 传 owner 配置（记 owner 而非借用目标），此处按同一语义注册
    const ownerConfig: AgentConfig = { id: "a1", name: "A1", persona: "", model: "mock", skills: [], tools: [] };
    backgroundManager.register(makeTask("t-puppet"), ownerConfig, 60_000, "puppet");
    await vi.waitFor(() => expect(backgroundManager.get("t-puppet")?.status).toBe("completed"));

    const res = await authedRequest(app.server).get("/subagents/background/t-puppet");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      taskId: "t-puppet",
      parentAgentId: "a1",
      agentId: "a1",
      kind: "puppet",
      status: "completed",
    });
  });

  it("输出双轨：summary 是截尾 preview，/output 端点返回全量", async () => {
    const big = "y".repeat(5000) + "END";
    await app.close();
    await cleanup();

    const built = await buildContext(async () => big);
    backgroundManager = built.backgroundManager;
    cleanup = built.cleanup;
    app = await createServer(built.context);
    await app.ready();

    backgroundManager.register(makeTask("t-big"), config, 60_000);
    await vi.waitFor(() => expect(backgroundManager.get("t-big")?.status).toBe("completed"));

    const summary = await authedRequest(app.server).get("/subagents/background/t-big");
    expect(summary.body.outputTruncated).toBe(true);
    expect(summary.body.output.length).toBe(4096);
    expect(summary.body.output.endsWith("END")).toBe(true);

    const full = await authedRequest(app.server).get("/subagents/background/t-big/output?agentId=a1");
    expect(full.status).toBe(200);
    expect(full.body.output).toBe(big);

    const missing = await authedRequest(app.server).get("/subagents/background/nope/output?agentId=a1");
    expect(missing.status).toBe(404);
  });

  it("M35：/output 端点 owner 校验——缺 agentId 400，非 owner 按不存在 404", async () => {
    backgroundManager.register(makeTask("t-owner"), config, 60_000);
    await vi.waitFor(() => expect(backgroundManager.get("t-owner")?.status).toBe("completed"));

    const noAgent = await authedRequest(app.server).get("/subagents/background/t-owner/output");
    expect(noAgent.status).toBe(400);
    expect(noAgent.body.error).toContain("agentId");

    // 非 owner 与不存在同口径 404，不泄露任务存在性
    const notOwner = await authedRequest(app.server).get("/subagents/background/t-owner/output?agentId=other");
    expect(notOwner.status).toBe(404);

    const ok = await authedRequest(app.server).get("/subagents/background/t-owner/output?agentId=a1");
    expect(ok.status).toBe(200);
    expect(ok.body.output).toBe("bg result");
  });

  it("重启后 lost 状态经 REST 正确暴露", async () => {
    // 上一世：任务永远 running（runAgent 不返回），等 running 记录落盘后模拟重启
    await app.close();
    await cleanup();
    const built = await buildContext(() => new Promise<string>(() => {}));
    backgroundManager = built.backgroundManager;
    cleanup = built.cleanup;
    app = await createServer(built.context);
    await app.ready();

    backgroundManager.register(makeTask("t-lost"), config, 60_000);
    const repoFile = path.join(process.env.CLOUDMIND_DATA_DIR!, "subagent-tasks.jsonl");
    await vi.waitFor(async () => {
      const records = await new SubagentTaskRepository(repoFile).loadAll();
      expect(records.find((r) => r.taskId === "t-lost")?.status).toBe("running");
    });
    await app.close();

    // 重启：新 manager 从同一 repository 文件 load，running 标 lost
    const manager2 = new BackgroundManager(
      { runAgent: async () => "" },
      new SubagentTaskRepository(repoFile),
    );
    await manager2.load();
    const app2 = await createServer({ ...built.context, backgroundManager: manager2 });
    await app2.ready();

    const res = await authedRequest(app2.server).get("/subagents/background/t-lost");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("lost");

    await app2.close();
  });
});
