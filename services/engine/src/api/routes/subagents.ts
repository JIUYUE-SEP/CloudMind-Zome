import type { FastifyInstance } from "fastify";
import type { ApiContext } from "../context.js";
import type { BackgroundSubagent } from "../../subagent/background.js";

/** 序列化后台任务，避免泄露完整 agent 配置 */
function toSummary(bg: BackgroundSubagent) {
  return {
    taskId: bg.task.id,
    parentAgentId: bg.task.parentAgentId,
    agentId: bg.config.id,
    taskDescription: bg.task.taskDescription,
    status: bg.status,
    output: bg.output,
    error: bg.error,
    startTime: bg.startTime,
    timeoutMs: bg.timeoutMs,
  };
}

export async function registerSubagentRoutes(app: FastifyInstance, context: ApiContext) {
  app.get("/subagents/background", {
    schema: { summary: "List background subagent tasks", tags: ["subagents"] },
  }, async () => {
    return (context.backgroundManager?.list() ?? []).map(toSummary);
  });

  app.get("/subagents/background/:taskId", {
    schema: { summary: "Get a background subagent task by id", tags: ["subagents"] },
  }, async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const bg = context.backgroundManager?.get(taskId);
    if (!bg) return reply.status(404).send({ error: "Task not found" });
    return toSummary(bg);
  });
}
