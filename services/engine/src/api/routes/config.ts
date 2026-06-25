import type { FastifyInstance } from "fastify";
import type { ApiContext } from "../context.js";
import { getBuiltinTools } from "../../tools/builtin/index.js";

export async function registerConfigRoutes(app: FastifyInstance, context: ApiContext) {
  app.get("/config", {
    schema: { summary: "Get system configuration", tags: ["config"] },
  }, async () => {
    const config = await context.configRepository.load();
    return {
      ...config.settings,
      providers: config.providers.map((p) => ({ ...p, apiKey: p.apiKey ? "***" : undefined })),
    };
  });

  app.put("/config", {
    schema: { summary: "Update system configuration", tags: ["config"] },
  }, async (request) => {
    const body = request.body as {
      memory?: Record<string, unknown>;
      tavilyApiKey?: string;
    };
    const config = await context.configRepository.load();
    if (body.memory) config.settings.memory = { ...config.settings.memory, ...body.memory } as typeof config.settings.memory;
    if (body.tavilyApiKey !== undefined) config.settings.tavilyApiKey = body.tavilyApiKey;
    await context.configRepository.save(config);
    return config.settings;
  });

  app.get("/config/tools", {
    schema: { summary: "List built-in tools", tags: ["config"] },
  }, async () => {
    return getBuiltinTools().map((t) => ({
      name: t.name,
      toolset: "builtin",
      safeToParallel: true,
    }));
  });
}
