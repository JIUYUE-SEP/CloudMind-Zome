import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import type { ChatMessage } from "@cloudmind/shared";
import { isValidAgentId } from "@cloudmind/shared";
import type { ApiContext } from "../context.js";
import type { PlanManager } from "../../plan/manager.js";

// 与 WS sanitizeInput 的文本上限保持一致
const MAX_GOAL_LENGTH = 10_000;

// 步骤硬超时缺省 5 分钟（M22）：provider 流挂起时 runAgent 永不 settle，
// plan 运行锁会永久 409；超时与客户端断连共用中止通道，被中止步骤标 aborted 可重跑
const DEFAULT_STEP_TIMEOUT_MS = 300_000;
const PLAN_STEP_TIMEOUT_ENV = "ZOME_PLAN_STEP_TIMEOUT_MS";

/** ZOME_PLAN_STEP_TIMEOUT_MS 覆盖步骤硬超时（未设/非正整数按缺省 5 分钟） */
function resolveStepTimeoutMs(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const raw = env[PLAN_STEP_TIMEOUT_ENV];
  if (raw === undefined || raw.trim() === "") return DEFAULT_STEP_TIMEOUT_MS;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_STEP_TIMEOUT_MS;
}

function userMessage(text: string): ChatMessage {
  return {
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    createdAt: new Date().toISOString(),
  };
}

export async function registerPlanRoutes(app: FastifyInstance, context: ApiContext) {
  // plan 级运行锁：同一 plan 同时只允许一个 /run，冲突返回 409
  const runningPlanIds = new Set<string>();

  /** 校验 agentId 并解析 PlanManager；失败时已写响应，返回 undefined */
  async function resolveManager(
    agentId: string,
    reply: { status(code: number): { send(body: unknown): unknown } }
  ): Promise<PlanManager | undefined> {
    if (!isValidAgentId(agentId)) {
      await reply.status(400).send({ error: "Invalid agent id" });
      return undefined;
    }
    if (!context.getPlanManager) {
      await reply.status(503).send({ error: "Plan manager not available" });
      return undefined;
    }
    const manager = await context.getPlanManager(agentId);
    if (!manager) {
      await reply.status(404).send({ error: "Agent not found" });
      return undefined;
    }
    return manager;
  }

  app.post("/agents/:agentId/plans", {
    schema: { summary: "Create a plan from a goal", tags: ["plans"] },
  }, async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const manager = await resolveManager(agentId, reply);
    if (!manager) return;
    // request.body 在无 body/无 content-type 时为 undefined，直接取属性会抛 TypeError
    const body = (request.body ?? {}) as { goal?: unknown };
    if (typeof body.goal !== "string" || !body.goal.trim()) {
      return reply.status(400).send({ error: "goal required" });
    }
    if (body.goal.length > MAX_GOAL_LENGTH) {
      return reply.status(400).send({ error: `goal too long (max ${MAX_GOAL_LENGTH} characters)` });
    }
    return manager.createPlan(body.goal);
  });

  app.get("/agents/:agentId/plans", {
    schema: { summary: "List plans of an agent", tags: ["plans"] },
  }, async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const manager = await resolveManager(agentId, reply);
    if (!manager) return;
    return manager.list();
  });

  app.get("/agents/:agentId/plans/:planId", {
    schema: { summary: "Get a plan by id", tags: ["plans"] },
  }, async (request, reply) => {
    const { agentId, planId } = request.params as { agentId: string; planId: string };
    const manager = await resolveManager(agentId, reply);
    if (!manager) return;
    const plan = manager.get(planId);
    if (!plan) return reply.status(404).send({ error: "Plan not found" });
    return plan;
  });

  app.post("/agents/:agentId/plans/:planId/run", {
    schema: { summary: "Run all pending steps of a plan sequentially", tags: ["plans"] },
  }, async (request, reply) => {
    const { agentId, planId } = request.params as { agentId: string; planId: string };
    const manager = await resolveManager(agentId, reply);
    if (!manager) return;
    if (!context.runAgentCollect) {
      return reply.status(503).send({ error: "Agent runner not available" });
    }
    const plan = manager.get(planId);
    if (!plan) return reply.status(404).send({ error: "Plan not found" });

    const runKey = `${agentId}:${planId}`;
    if (runningPlanIds.has(runKey)) {
      return reply.status(409).send({ error: "Plan is already running" });
    }
    runningPlanIds.add(runKey);

    // 客户端断连时中止正在执行的步骤，避免空转继续烧 token；
    // 正常完成时 done=true，响应结束触发的 close 不会误中止
    const controller = new AbortController();
    let done = false;
    request.raw.once("close", () => {
      if (!done) controller.abort();
    });

    try {
      const runAgent = context.runAgentCollect;
      const stepTimeoutMs = resolveStepTimeoutMs();
      // 顺序执行所有 pending 步骤；遇 failed 或 paused 停止后续步骤。
      // aborted 视为可恢复中断（上次断连/超时留下），与 pending 一起重跑
      for (const step of plan.steps) {
        if (step.status !== "pending" && step.status !== "aborted") continue;
        if (controller.signal.aborted) break;
        if (manager.get(planId)?.status === "paused") break;
        // 每步硬超时：与断连中止合并为单一信号，贯入执行与 executeStep 状态判定
        const stepSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(stepTimeoutMs)]);
        const updated = await manager.executeStep(
          planId,
          step.id,
          async (s) => runAgent(agentId, [userMessage(s.description)], { signal: stepSignal }),
          { signal: stepSignal },
        );
        if (updated.status === "failed") break;
        // 断连/超时中止：停止后续步骤（本步已标 aborted，待下次 /run 重跑）
        if (stepSignal.aborted) break;
      }
      return manager.get(planId);
    } finally {
      done = true;
      runningPlanIds.delete(runKey);
    }
  });

  app.post("/agents/:agentId/plans/:planId/pause", {
    schema: { summary: "Pause a plan", tags: ["plans"] },
  }, async (request, reply) => {
    const { agentId, planId } = request.params as { agentId: string; planId: string };
    const manager = await resolveManager(agentId, reply);
    if (!manager) return;
    if (!manager.get(planId)) return reply.status(404).send({ error: "Plan not found" });
    return manager.pause(planId);
  });

  app.post("/agents/:agentId/plans/:planId/resume", {
    schema: { summary: "Resume a paused plan", tags: ["plans"] },
  }, async (request, reply) => {
    const { agentId, planId } = request.params as { agentId: string; planId: string };
    const manager = await resolveManager(agentId, reply);
    if (!manager) return;
    if (!manager.get(planId)) return reply.status(404).send({ error: "Plan not found" });
    return manager.resume(planId);
  });

  app.post("/agents/:agentId/plans/:planId/retry", {
    schema: { summary: "Reset a failed step to pending", tags: ["plans"] },
  }, async (request, reply) => {
    const { agentId, planId } = request.params as { agentId: string; planId: string };
    const manager = await resolveManager(agentId, reply);
    if (!manager) return;
    if (!manager.get(planId)) return reply.status(404).send({ error: "Plan not found" });
    const body = (request.body ?? {}) as { stepId?: unknown };
    if (typeof body.stepId !== "string" || !body.stepId) {
      return reply.status(400).send({ error: "stepId required" });
    }
    try {
      return await manager.retry(planId, body.stepId);
    } catch {
      return reply.status(404).send({ error: "Step not found" });
    }
  });
}
