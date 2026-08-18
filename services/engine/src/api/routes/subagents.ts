import { logger } from "../../logger.js";
import type { FastifyInstance } from "fastify";
import type { ApiContext } from "../context.js";
import type { BackgroundSubagent } from "../../subagent/background.js";

/**
 * 序列化后台任务，避免泄露完整 agent 配置。
 * output 为 preview（超 ~4KB 截尾，outputTruncated 标记——行为变化，文档注明）；
 * 全量输出走 /subagents/background/:taskId/output?agentId=<parentAgentId>（M35 owner 校验）。
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
    attempts: bg.attempts,
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
    schema: {
      summary: "Get full output of a background subagent task",
      tags: ["subagents"],
      querystring: { type: "object", properties: { agentId: { type: "string" } } },
    },
  }, async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    // M35：owner 维度校验（同 resume 端点口径）——任务 parentAgentId 必须等于
    // query agentId，否则按不存在处理（不泄露归属）；持 token 不再能读任意任务输出
    const { agentId } = request.query as { agentId?: string };
    if (!agentId) return reply.status(400).send({ error: "agentId is required" });
    const manager = context.backgroundManager;
    const bg = manager?.get(taskId);
    if (!manager || !bg || bg.parentAgentId !== agentId) {
      return reply.status(404).send({ error: "Task not found" });
    }
    try {
      const output = await manager.readFullOutput(taskId);
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

  /**
   * 任务 resume（阶段 4）：终态任务同简报重跑（统一语义：delegate 非常驻会话、
   * 傀儡本无状态，复用原记录 taskId 不变、attempts+1）。
   * owner 校验：任务 parentAgentId 必须等于路径 agentId，否则按不存在处理（不泄露归属）。
   */
  app.post("/agents/:agentId/subagents/:taskId/resume", {
    schema: { summary: "Resume a terminal background subagent task", tags: ["subagents"] },
  }, async (request, reply) => {
    const { agentId, taskId } = request.params as { agentId: string; taskId: string };
    const manager = context.backgroundManager;
    const bg = manager?.get(taskId);
    if (!manager || !bg || bg.parentAgentId !== agentId) {
      return reply.status(404).send({ error: "Task not found" });
    }
    if (bg.status === "running") {
      return reply.status(409).send({ error: "Task is still running" });
    }
    // 并发 resume 竞态（review 建议）：双请求同过 409 前置检查时，
    // 第二个 manager.resume() 抛 "still running"——映射为 409 而非冒泡 500
    try {
      // H-1：resume 返回的 completion 必须接住——runTracked 失败路径会 reject，
      // 浮空 promise 在 Node ≥15 默认 throw 模式下 = unhandled rejection 崩进程。
      // 重跑结果经 onUpdate/轮询暴露，REST 只负责点火，失败记 warn 即可
      void manager.resume(taskId).completion.catch((err) => {
        logger.warn({ err, taskId }, "[subagents] resume 重跑失败");
      });
    } catch (err) {
      if (String(err).includes("still running")) {
        return reply.status(409).send({ error: "Task is still running" });
      }
      throw err;
    }
    return toSummary(manager.get(taskId)!);
  });
}
