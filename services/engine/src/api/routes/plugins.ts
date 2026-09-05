import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { isValidAgentId } from "@cloudmind/shared";
import type { ApiContext } from "../context.js";
import type { ExternalFace } from "../../plugins/external/index.js";
import {
  ManifestCorruptError,
  PLUGIN_NAME_PATTERN,
  pluginDirExists,
  readAgentManifest,
  readGlobalManifest,
  updateManifestEntry,
} from "../../plugins/external/manifest.js";
import type { ManifestPatch } from "../../plugins/external/manifest.js";
import { getAgentDir, getDataDir } from "../../config/paths.js";

/** external 面缺省时的空结果（形状即契约，与 ExternalFace 三字段一致） */
const EMPTY_RESULT: ExternalFace = { loaded: [], skipped: [], perAgent: [] };

/**
 * PUT 单条补丁校验（M1）：body 必须是对象；enabled/config 至少给一个；
 * enabled 必须布尔、config 必须 JSON 对象（非数组非标量）。
 */
function parsePatch(body: unknown): { patch: ManifestPatch } | { error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: "请求体必须是对象" };
  }
  const { enabled, config } = body as { enabled?: unknown; config?: unknown };
  if (enabled === undefined && config === undefined) {
    return { error: "enabled 与 config 至少提供一个" };
  }
  const patch: ManifestPatch = {};
  if (enabled !== undefined) {
    if (typeof enabled !== "boolean") return { error: "enabled 必须是布尔值" };
    patch.enabled = enabled;
  }
  if (config !== undefined) {
    if (typeof config !== "object" || config === null || Array.isArray(config)) {
      return { error: "config 必须是 JSON 对象（非数组非标量）" };
    }
    patch.config = config as Record<string, unknown>;
  }
  return { patch };
}

/** 清单损坏统一 409（M1 写安全：显式报错，绝不静默覆盖；GET 同口径——损坏文件不该被渲染成空清单诱导重建） */
function sendConflictIfCorrupt(reply: FastifyReply, err: unknown) {
  if (err instanceof ManifestCorruptError) {
    return reply.status(409).send({ error: err.message });
  }
  throw err;
}

export async function registerPluginRoutes(app: FastifyInstance, context: ApiContext) {
  app.get("/plugins", {
    schema: { summary: "Get external plugin load results", tags: ["plugins"] },
  }, async () => {
    // external 面未装配时按空结果返回（理论上不会发生——bootstrap 在 listen 前
    // 挂载 external；测试构造的 ApiContext 常省略该可选字段），不 500
    const face = context.external ?? EMPTY_RESULT;
    return { loaded: face.loaded, skipped: face.skipped, perAgent: face.perAgent };
  });

  /**
   * M1 管理面读：全局清单全量（条目 + 目录有 index.mjs 但未登记的名字）。
   * 文件缺失按空清单；文件损坏 → 409 显式报错（不静默按空清单渲染）。
   */
  app.get("/plugins/manifest", {
    schema: { summary: "Get global external plugin manifest (entries + unregistered dirs)", tags: ["plugins"] },
  }, async (request, reply) => {
    try {
      return await readGlobalManifest(getDataDir());
    } catch (err) {
      return sendConflictIfCorrupt(reply, err);
    }
  });

  /**
   * M1 管理面写：单条启用/禁用/config 写回 plugins.json（未登记 → 登记）。
   * 无热重载（决策 5）——只改清单文件，响应带 requiresRestart: true。
   */
  app.put("/plugins/manifest/:name", {
    schema: { summary: "Create or update one global manifest entry", tags: ["plugins"] },
  }, async (request, reply) => {
    const { name } = request.params as { name: string };
    // 白名单字符校验前置（400），早于目录存在性（404）
    if (!PLUGIN_NAME_PATTERN.test(name)) {
      return reply.status(400).send({ error: "Invalid plugin name" });
    }
    const parsed = parsePatch(request.body);
    if ("error" in parsed) return reply.status(400).send({ error: parsed.error });
    const dataDir = getDataDir();
    if (!(await pluginDirExists(dataDir, name))) {
      return reply.status(404).send({ error: "Plugin directory not found" });
    }
    try {
      const view = await updateManifestEntry(path.join(dataDir, "plugins.json"), "json", name, parsed.patch);
      return { ...view, requiresRestart: true };
    } catch (err) {
      return sendConflictIfCorrupt(reply, err);
    }
  });

  /** M1 管理面读：per-agent 清单（agents/<id>/plugins.yml），缺失按空清单 */
  app.get("/agents/:id/plugins/manifest", {
    schema: { summary: "Get per-agent external plugin manifest (plugins.yml)", tags: ["plugins"] },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    // 与其余 per-agent 路由同口径：非法 id 前置 400（早于 404 存在性检查）
    if (!isValidAgentId(id)) {
      return reply.status(400).send({ error: "Invalid agent id" });
    }
    const config = await context.agentRepository.get(id);
    if (!config) return reply.status(404).send({ error: "Agent not found" });
    try {
      return await readAgentManifest(getAgentDir(id));
    } catch (err) {
      return sendConflictIfCorrupt(reply, err);
    }
  });

  /** M1 管理面写：per-agent 单条写回 plugins.yml（js-yaml dump 保持 YAML 格式），语义同全局单条 */
  app.put("/agents/:id/plugins/manifest/:name", {
    schema: { summary: "Create or update one per-agent manifest entry", tags: ["plugins"] },
  }, async (request, reply) => {
    const { id, name } = request.params as { id: string; name: string };
    if (!isValidAgentId(id)) {
      return reply.status(400).send({ error: "Invalid agent id" });
    }
    if (!PLUGIN_NAME_PATTERN.test(name)) {
      return reply.status(400).send({ error: "Invalid plugin name" });
    }
    const parsed = parsePatch(request.body);
    if ("error" in parsed) return reply.status(400).send({ error: parsed.error });
    const config = await context.agentRepository.get(id);
    if (!config) return reply.status(404).send({ error: "Agent not found" });
    const dataDir = getDataDir();
    if (!(await pluginDirExists(dataDir, name))) {
      return reply.status(404).send({ error: "Plugin directory not found" });
    }
    try {
      const view = await updateManifestEntry(path.join(getAgentDir(id), "plugins.yml"), "yaml", name, parsed.patch);
      return { ...view, requiresRestart: true };
    } catch (err) {
      return sendConflictIfCorrupt(reply, err);
    }
  });
}
