import type { FastifyInstance } from "fastify";
import type { ApiContext } from "../context.js";
import type { BackgroundSubagent } from "../../subagent/background.js";

/**
 * 序列化后台任务，避免泄露完整 agent 配置。
 * output 为 preview（超 ~4KB 截尾，outputTruncated 标记——行为变化，文档注明）；
 * 全量输出走 /subagents/background/:taskId/output。
 */
function toSummary(bg: BackgroundSubagent) {
  return {
    taskId: bg.taskId,
    parentAgentId: bg.parentAgentId,
    agentId: bg.agentId,
    kind: bg.kind,
    taskDescription: bg.taskDescription,
    status: bg.status,
    output: bg.output,
    outputTruncated: bg.outputTruncated,
    error: bg.error,
    startTime: bg.startTime,
    endTime: bg.endTime,
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

  app.get("/subagents/background/:taskId/output", {
    schema: { summary: "Get full output of a background subagent task", tags: ["subagents"] },
  }, async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    if (!context.backgroundManager?.get(taskId)) {
      return reply.status(404).send({ error: "Task not found" });
    }
    try {
      const output = await context.backgroundManager.readFullOutput(taskId);
      if (output === undefined) return reply.status(404).send({ error: "Output not found" });
      return { taskId, output };
    } catch (err) {
      // 超过读取上限（review 建议的尺寸防护）：提示直接查文件，不整读入内存
      if (String(err).includes("超过读取上限")) {
        return reply.status(413).send({ error: String(err) });
      }
      throw err;
    }
  });
}
