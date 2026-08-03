import type { FastifyInstance } from "fastify";
import type { ApiContext } from "../context.js";

/** Puppet 型号库只读端点（第一版无 CRUD 写端点，自定义走 DATA_DIR/puppet-models/*.json） */
export async function registerPuppetModelRoutes(app: FastifyInstance, context: ApiContext) {
  app.get("/puppet-models", {
    schema: { summary: "List puppet models (builtin + custom)", tags: ["subagents"] },
  }, async () => {
    return (await context.puppetModelService?.list()) ?? [];
  });
}
