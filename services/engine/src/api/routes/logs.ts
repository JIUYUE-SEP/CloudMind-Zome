import type { FastifyInstance } from "fastify";
import { getBufferedLogs } from "../log-buffer.js";

const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 200;

export async function registerLogRoutes(app: FastifyInstance) {
  app.get("/logs", {
    schema: { summary: "Get recent engine logs", tags: ["logs"] },
  }, async (request) => {
    const { limit } = request.query as { limit?: string };
    const parsed = Number(limit);
    const n = Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.floor(parsed), MAX_LIMIT) : DEFAULT_LIMIT;
    return getBufferedLogs(n);
  });
}
