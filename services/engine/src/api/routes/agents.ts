import type { FastifyInstance } from "fastify";
import type { ApiContext } from "../context.js";
import type { AgentConfig } from "@mindcloud/shared";
import { ensureMindFiles } from "../../mind/mind-files.js";

function isValidAgentId(id: unknown): id is string {
  return typeof id === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(id);
}

export async function registerAgentRoutes(app: FastifyInstance, context: ApiContext) {
  app.get("/agents", {
    schema: { summary: "List all agents", tags: ["agents"] },
  }, async () => {
    return context.agentRepository.list();
  });

  app.post("/agents", {
    schema: { summary: "Create a new agent", tags: ["agents"] },
  }, async (request, reply) => {
    const config = request.body as AgentConfig;
    if (!config.id) {
      return reply.status(400).send({ error: "id is required" });
    }
    if (!isValidAgentId(config.id)) {
      return reply.status(400).send({ error: "Invalid agent id" });
    }
    await context.agentRepository.save(config.id, config);
    // 新建 Agent 生成默认 SOUL.md（人格模板）与 MIND.md（空经验档案）；已存在不覆盖
    await ensureMindFiles(config.id);
    return config;
  });

  app.get("/agents/:id", {
    schema: { summary: "Get an agent by id", tags: ["agents"] },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidAgentId(id)) {
      return reply.status(400).send({ error: "Invalid agent id" });
    }
    const config = await context.agentRepository.get(id);
    if (!config) return reply.status(404).send({ error: "Agent not found" });
    return config;
  });

  app.put("/agents/:id", {
    schema: { summary: "Update an agent", tags: ["agents"] },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const config = request.body as AgentConfig;
    if (!isValidAgentId(id)) {
      return reply.status(400).send({ error: "Invalid agent id" });
    }
    if (config.id !== undefined && config.id !== id) {
      return reply.status(400).send({ error: "Agent id in body does not match route parameter" });
    }
    if (config.id !== undefined && !isValidAgentId(config.id)) {
      return reply.status(400).send({ error: "Invalid agent id in body" });
    }
    await context.agentRepository.save(id, config);
    return config;
  });

  app.delete("/agents/:id", {
    schema: { summary: "Delete an agent", tags: ["agents"] },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidAgentId(id)) {
      return reply.status(400).send({ error: "Invalid agent id" });
    }
    await context.agentRepository.delete(id);
    // P1-3（review M3）：级联清理向量索引——sidecar 逐出 INDEX_CACHE 并删磁盘
    // indices 目录。sidecar 不可达时 warn 不阻断：目录统一后磁盘 embeddings 已随
    // 上面的 rm -rf agents/{id} 删除，残留仅是 sidecar 内存缓存（重启即清）。
    if (context.sidecarClient) {
      const ok = await context.sidecarClient.deleteAgent(id).catch(() => false);
      if (!ok) {
        console.warn(`[agents] sidecar DeleteAgent(${id}) 未成功，向量内存缓存待 sidecar 重启后清除`);
      }
    }
    return reply.status(204).send();
  });
}
