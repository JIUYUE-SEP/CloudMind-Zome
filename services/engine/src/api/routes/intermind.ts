import type { FastifyInstance } from "fastify";
import type { ApiContext } from "../context.js";
import { isValidAgentId } from "@mindcloud/shared";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

/** Intermind 只读端点（监护权：REST 可读人形间对话；一期无写端点，写走 send_private_message 工具） */
export async function registerIntermindRoutes(app: FastifyInstance, context: ApiContext) {
  app.get("/agents/:id/intermind", {
    schema: { summary: "List intermind sessions of an agent", tags: ["intermind"] },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidAgentId(id)) return reply.status(400).send({ error: "Invalid agent id" });
    const agent = await context.agentRepository.get(id);
    if (!agent) return reply.status(404).send({ error: "Agent not found" });
    return (await context.intermindService?.listSessions(id)) ?? [];
  });

  app.get("/agents/:id/intermind/:peerId/messages", {
    schema: {
      summary: "Get intermind messages between an agent and a peer",
      tags: ["intermind"],
      querystring: {
        type: "object",
        properties: { limit: { type: "string" }, before: { type: "string" } },
      },
    },
  }, async (request, reply) => {
    const { id, peerId } = request.params as { id: string; peerId: string };
    if (!isValidAgentId(id) || !isValidAgentId(peerId)) {
      return reply.status(400).send({ error: "Invalid agent id" });
    }
    const agent = await context.agentRepository.get(id);
    if (!agent) return reply.status(404).send({ error: "Agent not found" });
    const raw = Number((request.query as { limit?: string }).limit);
    const limit = Math.min(
      Math.max(Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_LIMIT, 1),
      MAX_LIMIT,
    );
    const before = (request.query as { before?: string }).before;
    try {
      return (
        (await context.intermindService?.listMessages(id, peerId, {
          limit,
          ...(before !== undefined ? { before } : {}),
        })) ?? []
      );
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Invalid before cursor")) {
        return reply.status(400).send({ error: String(err) });
      }
      throw err;
    }
  });
}
