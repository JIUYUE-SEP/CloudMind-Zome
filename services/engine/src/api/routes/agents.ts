import { logger } from "../../logger.js";
import type { FastifyInstance } from "fastify";
import type { ApiContext } from "../context.js";
import type { AgentConfig } from "@mindcloud/shared";
import { isValidAgentId } from "@mindcloud/shared";
import { ensureMindFiles } from "../../mind/mind-files.js";
import { HANDOFF_MAX_SHIFTS_MIN, HANDOFF_MAX_SHIFTS_MAX } from "../../handoff/types.js";

// AgentConfig 已知字段（功能 Minor-1）：POST/PUT 对未知字段显式 400，
// 不再静默忽略——客户端写错字段名（如 provider 而非 providerId）时错误
// 配置曾静默落盘，失败被推迟到聊天时才暴露。
// schemaVersion 是 P1-1 落盘版本戳：GET 回显后 PUT 原样回传属合法。
const KNOWN_AGENT_FIELDS = new Set([
  "id", "name", "codename", "description", "persona", "tags", "representColor",
  "providerId", "modelId", "model", "embedderProviderId", "embedderModelId",
  "fallbackProviderIds",
  "subagentNotify",
  "imageProviderId", "imageModelId", "temperature", "topP", "maxContextTokens",
  "reactMaxSteps", "handoffMaxShifts",
  "trustAllTools",
  "compressionModel", "topicDetectionWindowMinutes", "topicMessageThreshold",
  "semanticSearchEnabled", "semanticTopK", "semanticMinScore",
  "skills", "tools", "schemaVersion",
]);

/** 常见写错字段名 → 正确写法（报错信息里给提示） */
const FIELD_HINTS: Record<string, string> = {
  provider: "providerId",
  model_id: "modelId",
  embedder: "embedderProviderId",
  image: "imageProviderId",
  top_p: "topP",
  max_context_tokens: "maxContextTokens",
  react_max_steps: "reactMaxSteps",
  handoff_max_shifts: "handoffMaxShifts",
  compression_model: "compressionModel",
};

function unknownFieldsError(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return "请求体必须是对象";
  }
  const unknown = Object.keys(body).filter((k) => !KNOWN_AGENT_FIELDS.has(k));
  if (unknown.length === 0) return undefined;
  return `未知字段: ${unknown
    .map((k) => (FIELD_HINTS[k] ? `${k}（你是不是想写 ${FIELD_HINTS[k]}？）` : k))
    .join("、")}`;
}

/** handoffMaxShifts 校验：缺省（undefined/null）放行，其余必须是 1-10 整数（R3） */
function validateHandoffMaxShifts(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < HANDOFF_MAX_SHIFTS_MIN ||
    value > HANDOFF_MAX_SHIFTS_MAX
  ) {
    return `handoffMaxShifts 必须是 ${HANDOFF_MAX_SHIFTS_MIN}-${HANDOFF_MAX_SHIFTS_MAX} 的整数`;
  }
  return undefined;
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
    const fieldsError = unknownFieldsError(config);
    if (fieldsError) {
      return reply.status(400).send({ error: fieldsError });
    }
    if (!config.id) {
      return reply.status(400).send({ error: "id is required" });
    }
    if (!isValidAgentId(config.id)) {
      return reply.status(400).send({ error: "Invalid agent id" });
    }
    const handoffError = validateHandoffMaxShifts(config.handoffMaxShifts);
    if (handoffError) {
      return reply.status(400).send({ error: handoffError });
    }
    // P1-9：重复 id 显式 409（对照 models 端点），不静默覆盖现有配置
    const existing = await context.agentRepository.get(config.id);
    if (existing) {
      return reply.status(409).send({ error: `Agent id already exists: ${config.id}` });
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
    const fieldsError = unknownFieldsError(config);
    if (fieldsError) {
      return reply.status(400).send({ error: fieldsError });
    }
    if (config.id !== undefined && config.id !== id) {
      return reply.status(400).send({ error: "Agent id in body does not match route parameter" });
    }
    if (config.id !== undefined && !isValidAgentId(config.id)) {
      return reply.status(400).send({ error: "Invalid agent id in body" });
    }
    const handoffError = validateHandoffMaxShifts(config.handoffMaxShifts);
    if (handoffError) {
      return reply.status(400).send({ error: handoffError });
    }
    // 合并语义（2026-08-01 起，真机验证踩坑修复）：未传字段保留原值，
    // 不再整体覆盖——部分更新的调用方曾把 persona/skills/tools 等字段静默洗掉。
    // 显式清空字段传空数组/空串；前端全量表单提交行为不受影响。
    const existing = await context.agentRepository.get(id);
    const merged = existing ? { ...existing, ...config, id } : config;
    await context.agentRepository.save(id, merged);
    return merged;
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
        logger.warn(`[agents] sidecar DeleteAgent(${id}) 未成功，向量内存缓存待 sidecar 重启后清除`);
      }
    }
    return reply.status(204).send();
  });
}
