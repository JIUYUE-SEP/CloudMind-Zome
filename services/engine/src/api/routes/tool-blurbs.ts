import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { isValidAgentId } from "@cloudmind/shared";
import type { ApiContext } from "../context.js";

const regenerateBody = z.object({
  names: z.array(z.string().min(1)).max(64).optional(),
});

const putBody = z.object({
  blurb: z.string().min(1).max(200),
});

/**
 * blurb 管理 v3 端点三件套（spec 决策 3/5；全局 Bearer 自动涵盖）：
 * - GET /agents/:id/tool-catalog：三清单（dynamic/skills/builtin）+ status 四态；
 * - POST /agents/:id/tool-blurbs/regenerate：缺省只碰 missing/stale，user 跳过；
 * - PUT /tool-blurbs/:name：用户编辑（source:"user"），name 须在全局动态工具或
 *   某 agent skill 名录内（fail-closed 404，防乱写键名空间）。
 */
export async function registerToolBlurbRoutes(app: FastifyInstance, context: ApiContext) {
  app.get("/agents/:id/tool-catalog", {
    schema: { summary: "Tool/skill blurb catalog with status (dynamic/skills/builtin)", tags: ["agents"] },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidAgentId(id)) {
      return reply.status(400).send({ error: "Invalid agent id" });
    }
    const config = await context.agentRepository.get(id);
    if (!config) return reply.status(404).send({ error: "Agent not found" });
    if (!context.toolCatalog) {
      return reply.status(500).send({ error: "toolCatalog service not assembled (ApiContext.toolCatalog missing)" });
    }
    return context.toolCatalog.catalog(config);
  });

  app.post("/agents/:id/tool-blurbs/regenerate", {
    schema: { summary: "Regenerate blurbs (default: all missing/stale; user entries skipped)", tags: ["agents"] },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidAgentId(id)) {
      return reply.status(400).send({ error: "Invalid agent id" });
    }
    const config = await context.agentRepository.get(id);
    if (!config) return reply.status(404).send({ error: "Agent not found" });
    if (!context.toolCatalog) {
      return reply.status(500).send({ error: "toolCatalog service not assembled (ApiContext.toolCatalog missing)" });
    }
    let body: z.infer<typeof regenerateBody>;
    try {
      body = regenerateBody.parse(request.body ?? {});
    } catch (err) {
      return reply.status(400).send({ error: String(err) });
    }
    return context.toolCatalog.regenerate(id, config, body.names);
  });

  app.put("/tool-blurbs/:name", {
    schema: { summary: "User-edit a blurb (source:user; namespace fail-closed)", tags: ["agents"] },
  }, async (request, reply) => {
    if (!context.toolCatalog) {
      return reply.status(500).send({ error: "toolCatalog service not assembled (ApiContext.toolCatalog missing)" });
    }
    const { name } = request.params as { name: string };
    let body: z.infer<typeof putBody>;
    try {
      body = putBody.parse(request.body);
    } catch (err) {
      return reply.status(400).send({ error: String(err) });
    }
    const description = await context.toolCatalog.findDescription(name);
    if (description === undefined) {
      return reply.status(404).send({ error: `未知的 blurb 键名（须为动态工具限定名或 skill:<name>）: ${name}` });
    }
    return context.toolCatalog.putUser(name, body.blurb, description);
  });
}
