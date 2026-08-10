import type { FastifyInstance } from "fastify";
import type { ApiContext } from "../context.js";
import { isValidAgentId } from "@mindcloud/shared";
import { clampPageLimit, clampPageOffset } from "./pagination.js";

export async function registerActionRoutes(app: FastifyInstance, context: ApiContext) {
  app.get("/actions/:agentId", {
    schema: {
      summary: "List actions for an agent",
      tags: ["actions"],
      querystring: { type: "object", properties: { limit: { type: "string" }, offset: { type: "string" } } },
    },
  }, async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    if (!isValidAgentId(agentId)) {
      return reply.status(400).send({ error: "Invalid agent id" });
    }
    const { limit, offset } = request.query as { limit?: string; offset?: string };
    return context.getActionRepository(agentId).list({
      // A5：非法/0/负数回落缺省 100（不返回全量），上限 500 封顶；offset 非法回落 undefined
      limit: clampPageLimit(limit),
      offset: clampPageOffset(offset),
    });
  });
}
