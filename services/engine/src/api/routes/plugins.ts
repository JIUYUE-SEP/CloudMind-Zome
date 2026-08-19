import type { FastifyInstance } from "fastify";
import type { ApiContext } from "../context.js";
import type { ExternalFace } from "../../plugins/external/index.js";

/** external 面缺省时的空结果（形状即契约，与 ExternalFace 三字段一致） */
const EMPTY_RESULT: ExternalFace = { loaded: [], skipped: [], perAgent: [] };

export async function registerPluginRoutes(app: FastifyInstance, context: ApiContext) {
  app.get("/plugins", {
    schema: { summary: "Get external plugin load results", tags: ["plugins"] },
  }, async () => {
    // external 面未装配时按空结果返回（理论上不会发生——bootstrap 在 listen 前
    // 挂载 external；测试构造的 ApiContext 常省略该可选字段），不 500
    const face = context.external ?? EMPTY_RESULT;
    return { loaded: face.loaded, skipped: face.skipped, perAgent: face.perAgent };
  });
}
