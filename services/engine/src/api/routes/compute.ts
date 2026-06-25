import type { FastifyInstance } from "fastify";
import type { ApiContext } from "../context.js";
import OpenAI from "openai";

export async function registerComputeRoutes(app: FastifyInstance, context: ApiContext) {
  app.get("/compute/providers", {
    schema: { summary: "List compute providers", tags: ["compute"] },
  }, async () => {
    const config = await context.configRepository.load();
    return config.providers.map((p) => ({ ...p, apiKey: p.apiKey ? "***" : undefined }));
  });

  app.post("/compute/providers", {
    schema: { summary: "Create a compute provider", tags: ["compute"] },
  }, async (request) => {
    const body = request.body as {
      id?: string;
      displayName: string;
      providerType?: string;
      baseUrl: string;
      apiKey?: string;
      models?: unknown[];
    };
    const config = await context.configRepository.load();
    const provider = {
      id: body.id || crypto.randomUUID(),
      displayName: body.displayName,
      providerType: (body.providerType || "openai") as "openai",
      baseUrl: body.baseUrl,
      apiKey: body.apiKey,
      models: (body.models || []) as { id: string; displayName: string; modelType: "llm" | "embedding" | "image" | "stt" }[],
    };
    config.providers.push(provider);
    await context.configRepository.save(config);
    return provider;
  });

  app.put("/compute/providers/:id", {
    schema: { summary: "Update a compute provider", tags: ["compute"] },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as Partial<{
      displayName: string;
      baseUrl: string;
      apiKey: string;
    }>;
    const config = await context.configRepository.load();
    const idx = config.providers.findIndex((p) => p.id === id);
    if (idx < 0) return reply.status(404).send({ error: "Provider not found" });
    const existing = config.providers[idx];
    config.providers[idx] = {
      ...existing,
      displayName: body.displayName ?? existing.displayName,
      baseUrl: body.baseUrl ?? existing.baseUrl,
      apiKey: body.apiKey ?? existing.apiKey,
    };
    await context.configRepository.save(config);
    return config.providers[idx];
  });

  app.delete("/compute/providers/:id", {
    schema: { summary: "Delete a compute provider", tags: ["compute"] },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const config = await context.configRepository.load();
    config.providers = config.providers.filter((p) => p.id !== id);
    await context.configRepository.save(config);
    return reply.status(204).send();
  });

  app.post("/compute/providers/:id/test", {
    schema: { summary: "Test a compute provider connection", tags: ["compute"] },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const config = await context.configRepository.load();
    const provider = config.providers.find((p) => p.id === id);
    if (!provider) return reply.status(404).send({ error: "Provider not found" });
    try {
      const client = new OpenAI({ apiKey: provider.apiKey, baseURL: provider.baseUrl });
      const models = await client.models.list();
      const discovered = models.data.map((m) => ({
        id: m.id,
        displayName: m.id,
        modelType: "llm" as const,
      }));
      return { ok: true, discovered };
    } catch (err) {
      return reply.status(500).send({ ok: false, error: String(err) });
    }
  });

  app.get("/compute/usage", {
    schema: { summary: "Get compute usage statistics", tags: ["compute"] },
  }, async () => {
    return { dates: [], tokens: [] };
  });

  app.post("/compute/providers/:id/models", {
    schema: { summary: "Add a model to a provider", tags: ["compute"] },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as Record<string, unknown>;
    const config = await context.configRepository.load();
    const provider = config.providers.find((p) => p.id === id);
    if (!provider) return reply.status(404).send({ error: "Provider not found" });
    provider.models.push(body as { id: string; displayName: string; modelType: "llm" | "embedding" | "image" | "stt" });
    await context.configRepository.save(config);
    return body;
  });

  app.put("/compute/providers/:id/models/:modelId", {
    schema: { summary: "Update a provider model", tags: ["compute"] },
  }, async (request, reply) => {
    const { id, modelId } = request.params as { id: string; modelId: string };
    const body = request.body as Record<string, unknown>;
    const config = await context.configRepository.load();
    const provider = config.providers.find((p) => p.id === id);
    if (!provider) return reply.status(404).send({ error: "Provider not found" });
    const idx = provider.models.findIndex((m) => m.id === modelId);
    if (idx < 0) return reply.status(404).send({ error: "Model not found" });
    provider.models[idx] = { ...provider.models[idx], ...body };
    await context.configRepository.save(config);
    return provider.models[idx];
  });

  app.delete("/compute/providers/:id/models/:modelId", {
    schema: { summary: "Delete a provider model", tags: ["compute"] },
  }, async (request, reply) => {
    const { id, modelId } = request.params as { id: string; modelId: string };
    const config = await context.configRepository.load();
    const provider = config.providers.find((p) => p.id === id);
    if (!provider) return reply.status(404).send({ error: "Provider not found" });
    provider.models = provider.models.filter((m) => m.id !== modelId);
    await context.configRepository.save(config);
    return reply.status(204).send();
  });
}
