import Fastify from "fastify";
import websocket from "@fastify/websocket";
import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { ApiContext } from "./context.js";
import { loggerStreams } from "../logger.js";
import { extractBearerToken, getAuthToken, isTokenValid } from "../config/auth-token.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerFileRoutes } from "./routes/files.js";
import { registerToolBlurbRoutes } from "./routes/tool-blurbs.js";
import { registerE2eMockRoutes } from "./routes/e2e-mock.js";
import { DEFAULT_ENGINE_URL } from "@cloudmind/shared";
import { registerChatRoutes } from "./routes/chat.js";
import { registerMemoryRoutes } from "./routes/memory.js";
import { registerTopicRoutes } from "./routes/topics.js";
import { registerActionRoutes } from "./routes/actions.js";
import { registerSkillRoutes } from "./routes/skills.js";
import { registerComputeRoutes } from "./routes/compute.js";
import { registerConfigRoutes } from "./routes/config.js";
import { registerSchedulerRoutes } from "./routes/scheduler.js";
import { registerBlueprintRoutes } from "./routes/blueprints.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerPlanRoutes } from "./routes/plans.js";
import { registerSubagentRoutes } from "./routes/subagents.js";
import { registerPuppetModelRoutes } from "./routes/puppet-models.js";
import { registerIntermindRoutes } from "./routes/intermind.js";
import { registerLogRoutes } from "./routes/logs.js";
import { registerHandoffRoutes } from "./routes/handoff.js";
import { registerPluginRoutes } from "./routes/plugins.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerWebSocketHandler } from "./ws/handler.js";
import { registerSessionWebSocket } from "./ws/session-handler.js";
import { isAllowedCorsOrigin } from "./ws/validation.js";

export async function createServer(context: ApiContext) {
  // Fastify 请求日志与业务日志共用同一流（P4-1）：stdout + /logs 环形缓冲
  const app = Fastify({
    logger: { stream: loggerStreams },
  });

  await app.register(cors, {
    // origin 判定收敛到 ws/validation.ts（F9：与 WS 握手同源的白名单）。
    // 拒绝时回 false：CORS 头整体不下发（原数组未命中时 204 但无 ACAO，
    // 浏览器同判拦截，阻断语义等价）
    origin: (origin, cb) => cb(null, isAllowedCorsOrigin(origin)),
    credentials: true,
    // @fastify/cors v11 默认只放行 CORS 安全方法（GET/HEAD/POST），
    // 不显式声明会导致浏览器对 PUT/DELETE 的预检失败（前端报 "Failed to fetch"）
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });
  await app.register(websocket, {
    // M30：限制单帧体积（ws 默认 100MiB 过大）——聊天文本上限 10k 字符，
    // 1MB 留足协议余量；超限帧由 ws 直接以 1009 断连
    options: { maxPayload: 1024 * 1024 },
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: "CloudMind Zome Engine API",
        description: "REST and WebSocket API for the CloudMind Zome engine",
        version: "2.0.0",
      },
      servers: [{ url: DEFAULT_ENGINE_URL }],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: "/docs",
    uiConfig: { docExpansion: "list", deepLinking: false },
  });

  // 本地 token 鉴权（P0-2）：除 /health（sidecar 健康检查）与 /ws/*
  // （WS 握手无法设请求头，token 由 handler 校验 subprotocol）外，
  // 全部 REST 要求 Authorization: Bearer <token>。/docs 也在保护范围内。
  app.addHook("onRequest", async (req, reply) => {
    const url = req.url.split("?")[0];
    if (url === "/health" || url.startsWith("/ws/")) return;
    const expected = await getAuthToken();
    if (!isTokenValid(extractBearerToken(req.headers.authorization), expected)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
  });

  app.get("/health", async () => ({ status: "ok" }));

  await registerAgentRoutes(app, context);
  await registerFileRoutes(app, context);
  await registerToolBlurbRoutes(app, context);
  // e2e 注入端点（决策 1 硬闸）：仅 e2e 环境注册——生产构建路径零存在（404）
  if (process.env.NODE_ENV === "e2e") {
    await registerE2eMockRoutes(app, context);
  }
  await registerChatRoutes(app, context);
  await registerMemoryRoutes(app, context);
  await registerTopicRoutes(app, context);
  await registerActionRoutes(app, context);
  await registerSkillRoutes(app, context);
  await registerComputeRoutes(app, context);
  await registerConfigRoutes(app, context);
  await registerSchedulerRoutes(app, context);
  await registerBlueprintRoutes(app, context);
  await registerSessionRoutes(app, context);
  await registerPlanRoutes(app, context);
  await registerSubagentRoutes(app, context);
  await registerPuppetModelRoutes(app, context);
  await registerIntermindRoutes(app, context);
  await registerLogRoutes(app);
  await registerHandoffRoutes(app, context);
  await registerPluginRoutes(app, context);
  await registerSystemRoutes(app, context);
  await registerSessionWebSocket(app, context);
  await registerWebSocketHandler(app, context);

  return app;
}
