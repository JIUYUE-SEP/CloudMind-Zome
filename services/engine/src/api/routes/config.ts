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
      tavilyApiKey: config.settings.tavilyApiKey ? "***" : undefined,
      providers: config.providers.map((p) => ({ ...p, apiKey: p.apiKey ? "***" : undefined })),
    };
  });

  app.put("/config", {
    schema: { summary: "Update system configuration", tags: ["config"] },
  }, async (request) => {
    // M28：无 body/无 content-type 时 request.body 为 undefined，?? {} 兜底避免 TypeError 500（同 plans.ts 口径）
    const body = (request.body ?? {}) as {
      memory?: Record<string, unknown>;
      tavilyApiKey?: string;
      sidecarAutoStart?: unknown;
    };
    // 读-改-写走 repository.update（写队列槽位内读最新再改再写），跨请求不互丢更新
    const { config } = await context.configRepository.update((cfg) => {
      if (body.memory) cfg.settings.memory = { ...cfg.settings.memory, ...body.memory } as typeof cfg.settings.memory;
      // 语义：undefined（字段缺失）= 不修改；空字符串 = 清除已保存的 key；
      // "***" 是 GET 掩码，原样回写会毁掉真实密钥，同样视为"不修改"
      if (body.tavilyApiKey !== undefined && body.tavilyApiKey !== "***") {
        cfg.settings.tavilyApiKey = body.tavilyApiKey === "" ? undefined : body.tavilyApiKey;
      }
      // sidecar 自启开关：只接受真 boolean，其余形态不修改（缺省 false 语义在读取方）
      if (typeof body.sidecarAutoStart === "boolean") {
        cfg.settings.sidecarAutoStart = body.sidecarAutoStart;
      }
    });
    return {
      ...config.settings,
      tavilyApiKey: config.settings.tavilyApiKey ? "***" : undefined,
    };
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
