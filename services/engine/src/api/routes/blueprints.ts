import type { FastifyInstance } from "fastify";
import type { ApiContext } from "../context.js";
import { executeBlueprint } from "../../blueprint/engine.js";
import type { Blueprint } from "../../blueprint/types.js";

export async function registerBlueprintRoutes(app: FastifyInstance, context: ApiContext) {
  app.get("/blueprints", {
    schema: { summary: "List blueprints", tags: ["blueprints"] },
  }, async () => {
    return context.blueprintRepository.list();
  });

  app.post("/blueprints", {
    schema: { summary: "Create a blueprint", tags: ["blueprints"] },
  }, async (request, reply) => {
    const body = request.body as { name: string; nodes: unknown[]; edges: unknown[] };
    if (!body.name) return reply.status(400).send({ error: "name required" });
    return context.blueprintRepository.create({
      name: body.name,
      nodes: (body.nodes || []) as Blueprint["nodes"],
      edges: (body.edges || []) as Blueprint["edges"],
    });
  });

  app.get("/blueprints/:id", {
    schema: { summary: "Get a blueprint by id", tags: ["blueprints"] },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const blueprint = await context.blueprintRepository.get(id);
    if (!blueprint) return reply.status(404).send({ error: "Blueprint not found" });
    return blueprint;
  });

  app.put("/blueprints/:id", {
    schema: { summary: "Update a blueprint", tags: ["blueprints"] },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { name?: string; nodes?: unknown[]; edges?: unknown[] };
    const blueprint = await context.blueprintRepository.get(id);
    if (!blueprint) return reply.status(404).send({ error: "Blueprint not found" });
    if (body.name !== undefined) blueprint.name = body.name;
    if (body.nodes !== undefined) blueprint.nodes = body.nodes as Blueprint["nodes"];
    if (body.edges !== undefined) blueprint.edges = body.edges as Blueprint["edges"];
    await context.blueprintRepository.update(blueprint);
    return blueprint;
  });

  app.delete("/blueprints/:id", {
    schema: { summary: "Delete a blueprint", tags: ["blueprints"] },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await context.blueprintRepository.delete(id);
    return reply.status(204).send();
  });

  app.post("/blueprints/:id/execute", {
    schema: { summary: "Execute a blueprint", tags: ["blueprints"] },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { initialInput?: string };
    const blueprint = await context.blueprintRepository.get(id);
    if (!blueprint) return reply.status(404).send({ error: "Blueprint not found" });
    const execution = await executeBlueprint(blueprint, context, { initialInput: body.initialInput });
    return execution;
  });
}
