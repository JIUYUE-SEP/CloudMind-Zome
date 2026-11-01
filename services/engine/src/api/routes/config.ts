import type { FastifyInstance } from "fastify";
import type { ApiContext } from "../context.js";
import type { WatchdogSettings } from "../../config/repository.js";
import { getBuiltinTools } from "../../tools/builtin/index.js";

/** 只认纯对象：null / 数组 / 字符串都是配置笔误，静默忽略好过写出读不懂的配置 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
      watchdog?: unknown;
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
      // 看护参数（P3/P4）：逐字段合并，缺席保持原值——与 memory 同口径。
      //
      // 这里只校验**形状**，不校验取值范围（0 / 负数 / 越界一律原样存下），
      // 归一留给插件侧 readSettings：看护的参数会在那里回缺省。两处都做
      // 会出现「接口拒了但插件本来能救」和「接口存了但行为不同」两种失败面。
      //
      // 逐字段而不是整体展开：semanticReview 整体替换会让「先配了 cooldownMs，
      // 之后只想打开 enabled」悄悄把冷却打回缺省，排查时极难看出原因。
      if (isPlainObject(body.watchdog)) {
        const patch = body.watchdog;
        const current = cfg.settings.watchdog ?? {};
        const next: WatchdogSettings = { ...current };
        if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
        if (typeof patch.stallThresholdMs === "number") next.stallThresholdMs = patch.stallThresholdMs;
        if (typeof patch.scanIntervalMs === "number") next.scanIntervalMs = patch.scanIntervalMs;
        if (isPlainObject(patch.semanticReview)) {
          const review = { ...current.semanticReview };
          const patchReview = patch.semanticReview;
          if (typeof patchReview.enabled === "boolean") review.enabled = patchReview.enabled;
          if (typeof patchReview.afterMs === "number") review.afterMs = patchReview.afterMs;
          if (typeof patchReview.cooldownMs === "number") review.cooldownMs = patchReview.cooldownMs;
          next.semanticReview = review;
        }
        cfg.settings.watchdog = next;
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
