import type { FastifyInstance } from "fastify";
import type { ApiContext } from "../context.js";
import type { HandoffRecord } from "../../handoff/types.js";

function toSummary(record: HandoffRecord) {
  return {
    id: record.id,
    agentId: record.agentId,
    sessionId: record.sessionId,
    reason: record.reason,
    status: record.status,
    shift: record.shift,
    maxShifts: record.maxShifts,
    bookMessageId: record.bookMessageId,
    bookText: record.bookText,
    used: record.used,
    window: record.window,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    resumeJobId: record.resumeJobId,
    abortReason: record.abortReason,
    chainId: record.chainId,
  };
}

/**
 * 换班移交控制面 REST（水位撞顶=换班不死）：
 * - GET /handoff?agentId=&sessionId= 查活跃/历史条目（前端重连对账用）；
 * - DELETE /handoff/:id 手动打断（与用户消息打断同语义，reason=manual）。
 */
export async function registerHandoffRoutes(app: FastifyInstance, context: ApiContext) {
  app.get("/handoff", {
    schema: {
      summary: "List handoff records（水位撞顶换班移交控制面）",
      tags: ["handoff"],
      querystring: {
        type: "object",
        properties: {
          agentId: { type: "string" },
          sessionId: { type: "string" },
        },
      },
    },
  }, async (request) => {
    const { agentId, sessionId } = request.query as { agentId?: string; sessionId?: string };
    return (context.handoffManager?.list({ agentId, sessionId }) ?? []).map(toSummary);
  });

  app.delete("/handoff/:id", {
    schema: { summary: "Abort an active handoff（手动打断自动续跑；running 期经 loop 注册表 abort 在途 job）", tags: ["handoff"] },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const manager = context.handoffManager;
    const record = manager?.get(id);
    if (!manager || !record) return reply.status(404).send({ error: "Handoff not found" });
    // 2026-08-10：与用户消息打断同语义，统一走 registry 仲裁面——先经该
    // agent+session 全部活跃 loop 清定时器 + abort 在途 job（含 running 期），
    // 再落控制面。无 loop（如 REST-only 调用方）时由 manager.abort 兜底。
    await context.handoffLoops?.cancel(record.agentId, record.sessionId, "manual");
    const updated = await manager.abort(id, "manual");
    return toSummary(updated!);
  });
}
