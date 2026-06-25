import type { FastifyInstance } from "fastify";
import type { ApiContext } from "../context.js";

export async function registerSkillRoutes(app: FastifyInstance, context: ApiContext) {
  void context;
  app.get("/skills", async () => {
    // Phase 6 placeholder: skills will be loaded by SkillManager in a later phase.
    return [];
  });
}
