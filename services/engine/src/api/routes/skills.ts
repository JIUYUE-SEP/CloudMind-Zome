import type { FastifyInstance } from "fastify";
import type { ApiContext } from "../context.js";

export async function registerSkillRoutes(app: FastifyInstance, context: ApiContext) {
  app.get("/skills", {
    schema: { summary: "List available skills", tags: ["skills"] },
  }, async () => {
    return (await context.listSkills?.()) ?? [];
  });
}
