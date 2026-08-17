import type { FastifyInstance } from "fastify";
import type { ApiContext } from "../context.js";
import { SchedulerRepository } from "../../scheduler/repository.js";
import { computeNextRun } from "../../scheduler/engine.js";
import { isValidAgentId } from "@mindcloud/shared";

export async function registerSchedulerRoutes(app: FastifyInstance, context: ApiContext) {
  app.get("/scheduler/:agentId", {
    schema: { summary: "List scheduled tasks for an agent", tags: ["scheduler"] },
  }, async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    if (!isValidAgentId(agentId)) {
      return reply.status(400).send({ error: "Invalid agent id" });
    }
    const repo = new SchedulerRepository(agentId);
    return repo.list();
  });

  app.post("/scheduler/:agentId", {
    schema: { summary: "Create a scheduled task for an agent", tags: ["scheduler"] },
  }, async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    if (!isValidAgentId(agentId)) {
      return reply.status(400).send({ error: "Invalid agent id" });
    }
    // M27：拒绝幽灵任务——agent 不存在时创建的任务永远不会被 tick 扫到执行
    // （tick 只遍历 agentRepository.list()），与 agents/plans 路由同口径 404
    const agent = await context.agentRepository.get(agentId);
    if (!agent) return reply.status(404).send({ error: "Agent not found" });
    // M28：无 body/无 content-type 时 request.body 为 undefined，?? {} 兜底避免 TypeError 500（同 plans.ts 口径）
    const body = (request.body ?? {}) as { description: string; prompt: string; cron: string; enabled?: boolean };
    if (!body.description || !body.prompt || !body.cron) {
      return reply.status(400).send({ error: "description, prompt, cron required" });
    }
    const nextRunAt = computeNextRun(body.cron);
    if (!nextRunAt) {
      return reply.status(400).send({ error: "invalid cron expression" });
    }
    const repo = new SchedulerRepository(agentId);
    const task = await repo.create({
      agentId,
      description: body.description,
      prompt: body.prompt,
      cron: body.cron,
      enabled: body.enabled ?? true,
      nextRunAt,
    });
    return task;
  });

  app.put("/scheduler/:agentId/:taskId", {
    schema: { summary: "Update a scheduled task", tags: ["scheduler"] },
  }, async (request, reply) => {
    const { agentId, taskId } = request.params as { agentId: string; taskId: string };
    if (!isValidAgentId(agentId)) {
      return reply.status(400).send({ error: "Invalid agent id" });
    }
    // M27：同 POST——幽灵 agent 不允许更新任务
    const agent = await context.agentRepository.get(agentId);
    if (!agent) return reply.status(404).send({ error: "Agent not found" });
    const body = (request.body ?? {}) as Partial<{ description: string; prompt: string; cron: string; enabled: boolean }>;
    const repo = new SchedulerRepository(agentId);
    const task = await repo.get(taskId);
    if (!task) return reply.status(404).send({ error: "Task not found" });

    if (body.description !== undefined) task.description = body.description;
    if (body.prompt !== undefined) task.prompt = body.prompt;
    if (body.cron !== undefined) {
      const nextRunAt = computeNextRun(body.cron);
      if (!nextRunAt) return reply.status(400).send({ error: "invalid cron expression" });
      task.cron = body.cron;
      task.nextRunAt = nextRunAt;
    }
    if (body.enabled !== undefined) {
      task.enabled = body.enabled;
      if (task.enabled && !task.nextRunAt) {
        task.nextRunAt = computeNextRun(task.cron);
      }
    }

    await repo.update(task);
    return task;
  });

  app.delete("/scheduler/:agentId/:taskId", {
    schema: { summary: "Delete a scheduled task", tags: ["scheduler"] },
  }, async (request, reply) => {
    const { agentId, taskId } = request.params as { agentId: string; taskId: string };
    if (!isValidAgentId(agentId)) {
      return reply.status(400).send({ error: "Invalid agent id" });
    }
    const repo = new SchedulerRepository(agentId);
    // M32：删除不存在资源与 GET/PUT 同口径返回 404，不再恒 204
    const task = await repo.get(taskId);
    if (!task) return reply.status(404).send({ error: "Task not found" });
    await repo.delete(taskId);
    return reply.status(204).send();
  });
}
