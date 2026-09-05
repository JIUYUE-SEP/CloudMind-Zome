import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { authedRequest, TEST_AUTH_TOKEN } from "../helpers/auth.js";
import http from "node:http";
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
import { PlanManager } from "../../src/plan/manager.js";
import { MockLLMProvider } from "../../src/provider/llm.js";
import type { ApiContext } from "../../src/api/context.js";
import type { FastifyInstance } from "fastify";
import type { ChatMessage } from "@cloudmind/shared";
import { restoreDataDir } from "../helpers/env.js";

function extractText(messages: ChatMessage[]): string {
  return messages
    .flatMap((m) => m.content)
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");
}

async function buildContext(
  agentId: string,
  runAgentImpl?: (id: string, messages: ChatMessage[], opts?: { signal?: AbortSignal }) => Promise<string>,
): Promise<{
  context: ApiContext;
  planManager: PlanManager;
  cleanup: () => Promise<void>;
}> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "plans-api-test-"));
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

  const planManager = new PlanManager({ provider: new MockLLMProvider(), model: "mock" });

  const context: ApiContext = {
    agentRepository,
    getMessageRepository: (id: string) => new MessageRepository(id),
    getMemoryRepository: (id: string) => new MemoryRepository(id),
    getActionRepository: (id: string) => new ActionRepository(id),
    getLLMCallRepository: (id: string) => new LLMCallRepository(id),
    configRepository: new ConfigRepository(),
    sessionRepository: new SessionRepository(),
    blueprintRepository: new BlueprintRepository(),
    getAgentWorker: async () => undefined,
    getPlanManager: async (id: string) => (id === agentId ? planManager : undefined),
    runAgentCollect: runAgentImpl ?? (async (_id: string, messages: ChatMessage[]) => {
      const text = extractText(messages);
      if (text.includes("fail-me")) throw new Error("step failed");
      return `done:${text}`;
    }),
  };

  return {
    context,
    planManager,
    cleanup: async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
      restoreDataDir(originalDataDir);
    },
  };
}

describe("Plans API", () => {
  let app: FastifyInstance;
  let context: ApiContext;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const built = await buildContext("a1");
    context = built.context;
    cleanup = built.cleanup;
    app = await createServer(context);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await cleanup();
  });

  it("creates a plan from a multi-line goal", async () => {
    const res = await authedRequest(app.server)
      .post("/agents/a1/plans")
      .send({ goal: "- step one\n- step two" });
    expect(res.status).toBe(200);
    expect(res.body.steps).toHaveLength(2);
    expect(res.body.status).toBe("pending");
  });

  it("returns 400 for invalid agent id and missing goal", async () => {
    const bad = await authedRequest(app.server).post("/agents/invalid!/plans").send({ goal: "x" });
    expect(bad.status).toBe(400);
    const noGoal = await authedRequest(app.server).post("/agents/a1/plans").send({});
    expect(noGoal.status).toBe(400);
  });

  it("returns 400 (not 500) when body is missing entirely", async () => {
    // 无 content-type 时 request.body 为 undefined，不能直接取属性
    const res = await authedRequest(app.server).post("/agents/a1/plans");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("goal required");
  });

  it("returns 400 (not 500) for non-string goal", async () => {
    const res = await authedRequest(app.server).post("/agents/a1/plans").send({ goal: 123 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("goal required");
  });

  it("returns 400 for oversized goal", async () => {
    const res = await authedRequest(app.server)
      .post("/agents/a1/plans")
      .send({ goal: "x".repeat(10_001) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/too long/);
  });

  it("returns 400 (not 500) for non-string stepId on retry", async () => {
    const created = await authedRequest(app.server).post("/agents/a1/plans").send({ goal: "goal" });
    const res = await authedRequest(app.server)
      .post(`/agents/a1/plans/${created.body.id}/retry`)
      .send({ stepId: 123 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("stepId required");
  });

  it("returns 404 for unknown agent", async () => {
    const res = await authedRequest(app.server).post("/agents/ghost/plans").send({ goal: "x" });
    expect(res.status).toBe(404);
  });

  it("lists and gets plans", async () => {
    const created = await authedRequest(app.server).post("/agents/a1/plans").send({ goal: "goal x" });
    const planId = created.body.id;

    const list = await authedRequest(app.server).get("/agents/a1/plans");
    expect(list.body).toHaveLength(1);

    const got = await authedRequest(app.server).get(`/agents/a1/plans/${planId}`);
    expect(got.body.goal).toBe("goal x");

    const missing = await authedRequest(app.server).get("/agents/a1/plans/nope");
    expect(missing.status).toBe(404);
  });

  it("runs all pending steps sequentially and stores outputs", async () => {
    const created = await authedRequest(app.server)
      .post("/agents/a1/plans")
      .send({ goal: "- alpha\n- beta" });
    const planId = created.body.id;

    const res = await authedRequest(app.server).post(`/agents/a1/plans/${planId}/run`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("completed");
    expect(res.body.steps.map((s: { output: string }) => s.output)).toEqual([
      "done:alpha",
      "done:beta",
    ]);
  });

  it("pauses and resumes a plan", async () => {
    const created = await authedRequest(app.server).post("/agents/a1/plans").send({ goal: "goal" });
    const planId = created.body.id;

    const paused = await authedRequest(app.server).post(`/agents/a1/plans/${planId}/pause`);
    expect(paused.body.status).toBe("paused");

    // 暂停时 run 不执行任何步骤
    const ran = await authedRequest(app.server).post(`/agents/a1/plans/${planId}/run`);
    expect(ran.body.status).toBe("paused");
    expect(ran.body.steps[0].status).toBe("pending");

    const resumed = await authedRequest(app.server).post(`/agents/a1/plans/${planId}/resume`);
    expect(resumed.body.status).toBe("pending");
  });

  it("stops on failed step and retry resets it", async () => {
    const created = await authedRequest(app.server)
      .post("/agents/a1/plans")
      .send({ goal: "- ok step\n- fail-me\n- later step" });
    const planId = created.body.id;

    const ran = await authedRequest(app.server).post(`/agents/a1/plans/${planId}/run`);
    expect(ran.body.status).toBe("failed");
    expect(ran.body.steps[0].status).toBe("completed");
    expect(ran.body.steps[1].status).toBe("failed");
    // 后续步骤未被执行
    expect(ran.body.steps[2].status).toBe("pending");

    const retried = await authedRequest(app.server)
      .post(`/agents/a1/plans/${planId}/retry`)
      .send({ stepId: ran.body.steps[1].id });
    expect(retried.body.steps[1].status).toBe("pending");
    expect(retried.body.status).toBe("pending");
  });

  it("returns 404 when retrying an unknown step", async () => {
    const created = await authedRequest(app.server).post("/agents/a1/plans").send({ goal: "goal" });
    const res = await authedRequest(app.server)
      .post(`/agents/a1/plans/${created.body.id}/retry`)
      .send({ stepId: "nope" });
    expect(res.status).toBe(404);
  });

  it("returns 409 when the plan is already running", async () => {
    const calls: number[] = [];
    let release: ((text: string) => void) | undefined;
    const gate = new Promise<string>((resolve) => (release = resolve));
    const local = await buildContext("a1", async () => {
      calls.push(1);
      return gate;
    });
    const localApp = await createServer(local.context);
    await localApp.ready();
    try {
      const created = await authedRequest(localApp.server).post("/agents/a1/plans").send({ goal: "- one" });
      const planId = created.body.id;

      // 第一个 /run 会卡在 gate 上；第二个应立刻 409
      const first = authedRequest(localApp.server).post(`/agents/a1/plans/${planId}/run`);
      void first.then(() => {}, () => {}); // 启动请求
      await vi.waitFor(() => expect(calls).toHaveLength(1));

      const second = await authedRequest(localApp.server).post(`/agents/a1/plans/${planId}/run`);
      expect(second.status).toBe(409);
      expect(second.body.error).toMatch(/already running/);

      release!("done");
      const firstRes = await first;
      expect(firstRes.status).toBe(200);
    } finally {
      await localApp.close();
      await local.cleanup();
    }
  });

  it("aborts the running step when the client disconnects", async () => {
    let receivedSignal: AbortSignal | undefined;
    const local = await buildContext("a1", (_id, _messages, opts) => {
      receivedSignal = opts?.signal;
      return new Promise<string>((_, reject) => {
        opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });
    const localApp = await createServer(local.context);
    await localApp.listen({ port: 0, host: "127.0.0.1" });
    try {
      const created = await authedRequest(localApp.server).post("/agents/a1/plans").send({ goal: "- one" });
      const planId = created.body.id;
      const address = localApp.server.address() as { port: number };

      // 裸 socket 客户端：step 开始执行后立即断连
      const req = http.request({
        method: "POST",
        host: "127.0.0.1",
        port: address.port,
        path: `/agents/a1/plans/${planId}/run`,
        headers: { Authorization: `Bearer ${TEST_AUTH_TOKEN}` },
      });
      req.on("error", () => {});
      req.end();
      await vi.waitFor(() => expect(receivedSignal).toBeDefined());
      req.destroy();

      // 断连应中止正在执行的 step（M22：标 aborted 而非 failed——可恢复中断，
      // 下次 /run 会重跑），而不是空转到自然结束
      await vi.waitFor(() => expect(receivedSignal?.aborted).toBe(true));
      await vi.waitFor(() =>
        expect(local.planManager.get(planId)?.steps[0].status).toBe("aborted"),
      );
    } finally {
      await localApp.close();
      await local.cleanup();
    }
  });

  it("M22：步骤硬超时标 aborted 并释放运行锁，重跑会重新执行 aborted 步骤", async () => {
    const prevTimeout = process.env.ZOME_PLAN_STEP_TIMEOUT_MS;
    process.env.ZOME_PLAN_STEP_TIMEOUT_MS = "50";
    try {
      let calls = 0;
      const local = await buildContext("a1", (_id, _messages, opts) => {
        calls += 1;
        if (calls === 1) {
          // 首轮挂起直到信号中止（模拟 provider 流挂起），触发 50ms 硬超时
          return new Promise<string>((_, reject) => {
            opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          });
        }
        return Promise.resolve("done:second-run");
      });
      const localApp = await createServer(local.context);
      await localApp.ready();
      try {
        const created = await authedRequest(localApp.server).post("/agents/a1/plans").send({ goal: "- one" });
        const planId = created.body.id;

        const first = await authedRequest(localApp.server).post(`/agents/a1/plans/${planId}/run`);
        expect(first.status).toBe(200);
        expect(first.body.steps[0].status).toBe("aborted");
        expect(first.body.status).toBe("pending");

        // 锁已释放（不再 409）；aborted 步骤随 /run 重新执行
        const second = await authedRequest(localApp.server).post(`/agents/a1/plans/${planId}/run`);
        expect(second.status).toBe(200);
        expect(second.body.steps[0].status).toBe("completed");
        expect(second.body.steps[0].output).toBe("done:second-run");
        expect(second.body.status).toBe("completed");
        expect(calls).toBe(2);
      } finally {
        await localApp.close();
        await local.cleanup();
      }
    } finally {
      if (prevTimeout === undefined) {
        delete process.env.ZOME_PLAN_STEP_TIMEOUT_MS;
      } else {
        process.env.ZOME_PLAN_STEP_TIMEOUT_MS = prevTimeout;
      }
    }
  });
});
