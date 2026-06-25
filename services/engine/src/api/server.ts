import Fastify from "fastify";
import websocket from "@fastify/websocket";
import type { ApiContext } from "./context.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerMemoryRoutes } from "./routes/memory.js";
import { registerActionRoutes } from "./routes/actions.js";
import { registerSkillRoutes } from "./routes/skills.js";
import { registerWebSocketHandler } from "./ws/handler.js";

export async function createServer(context: ApiContext) {
  const app = Fastify({ logger: true });
  await app.register(websocket);

  app.get("/health", async () => ({ status: "ok" }));

  await registerAgentRoutes(app, context);
  await registerChatRoutes(app, context);
  await registerMemoryRoutes(app, context);
  await registerActionRoutes(app, context);
  await registerSkillRoutes(app, context);
  await registerWebSocketHandler(app, context);

  return app;
}
