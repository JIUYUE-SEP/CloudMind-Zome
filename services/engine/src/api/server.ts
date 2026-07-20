import Fastify from "fastify";
import websocket from "@fastify/websocket";
import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { ApiContext } from "./context.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerMemoryRoutes } from "./routes/memory.js";
import { registerActionRoutes } from "./routes/actions.js";
import { registerSkillRoutes } from "./routes/skills.js";
import { registerComputeRoutes } from "./routes/compute.js";
import { registerConfigRoutes } from "./routes/config.js";
import { registerSchedulerRoutes } from "./routes/scheduler.js";
import { registerBlueprintRoutes } from "./routes/blueprints.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerPlanRoutes } from "./routes/plans.js";
import { registerSubagentRoutes } from "./routes/subagents.js";
import { registerWebSocketHandler } from "./ws/handler.js";
import { registerSessionWebSocket } from "./ws/session-handler.js";
import { getAllowedOrigins } from "./ws/validation.js";

export async function createServer(context: ApiContext) {
  const app = Fastify({ logger: true });
  const allowedOrigins = getAllowedOrigins();

  await app.register(cors, {
    origin: process.env.NODE_ENV === "e2e" ? true : allowedOrigins,
    credentials: true,
    // @fastify/cors v11 默认只放行 CORS 安全方法（GET/HEAD/POST），
    // 不显式声明会导致浏览器对 PUT/DELETE 的预检失败（前端报 "Failed to fetch"）
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });
  await app.register(websocket);

  await app.register(swagger, {
    openapi: {
      info: {
        title: "CloudMind Zome Engine API",
        description: "REST and WebSocket API for the CloudMind Zome engine",
        version: "2.0.0",
      },
      servers: [{ url: "http://127.0.0.1:8848" }],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: "/docs",
    uiConfig: { docExpansion: "list", deepLinking: false },
  });

  app.get("/health", async () => ({ status: "ok" }));

  await registerAgentRoutes(app, context);
  await registerChatRoutes(app, context);
  await registerMemoryRoutes(app, context);
  await registerActionRoutes(app, context);
  await registerSkillRoutes(app, context);
  await registerComputeRoutes(app, context);
  await registerConfigRoutes(app, context);
  await registerSchedulerRoutes(app, context);
  await registerBlueprintRoutes(app, context);
  await registerSessionRoutes(app, context);
  await registerPlanRoutes(app, context);
  await registerSubagentRoutes(app, context);
  await registerSessionWebSocket(app, context);
  await registerWebSocketHandler(app, context);

  return app;
}
