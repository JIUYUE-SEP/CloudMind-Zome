import type { FastifyInstance } from "fastify";
import type { ApiContext } from "../context.js";
import { isValidAgentId } from "@cloudmind/shared";
import { clampPageLimit } from "./pagination.js";

export async function registerChatRoutes(app: FastifyInstance, context: ApiContext) {
  app.get("/chat/:agentId/messages", {
    schema: {
      summary: "Get chat messages for an agent session（含已归档，用户可见完整历史）",
      tags: ["chat"],
      querystring: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          limit: { type: "string" },
          before: { type: "string" },
        },
      },
    },
  }, async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    if (!isValidAgentId(agentId)) {
      return reply.status(400).send({ error: "Invalid agent id" });
    }
    const { sessionId, limit, before } = request.query as {
      sessionId?: string;
      limit?: string;
      before?: string;
    };
    if (!sessionId) {
      return reply.status(400).send({ error: "sessionId is required" });
    }
    // 用户可见完整历史：热存储 + 归档合并（话题压缩只收她的上下文，不动聊天记录）
    // M28：limit 与 sessions 路由同口径 clamp（A5）——非法值回落缺省 100，超上限封顶 500
    const messages = await context.getMessageRepository(agentId).listBySessionWithArchived(sessionId, {
      limit: clampPageLimit(limit),
      ...(before !== undefined ? { before } : {}),
    });
    return messages;
  });
}
