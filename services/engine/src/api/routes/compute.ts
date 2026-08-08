import { logger } from "../../logger.js";
import type { FastifyInstance } from "fastify";
import type { ApiContext } from "../context.js";
import OpenAI from "openai";
import { aggregateUsage } from "../../compute/usage.js";
import { isApiMode } from "../../provider/protocols/index.js";

function sanitizeProvider<T extends { apiKey?: string }>(provider: T): T {
  return { ...provider, apiKey: provider.apiKey ? "***" : undefined };
}

function isPrivateV4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local 整段，不只是元数据 IP
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

// 两个 hex 段还原成点分 IPv4（如 ("7f00","1") → "127.0.0.1"）
function hexPairToV4(hi: string, lo: string): string {
  const h = parseInt(hi, 16);
  const l = parseInt(lo, 16);
  return `${(h >> 8) & 255}.${h & 255}.${(l >> 8) & 255}.${l & 255}`;
}

function isPrivateIp(ip: string): boolean {
  const normalized = ip.replace(/^\[|\]$/g, "").toLowerCase();
  if (normalized.includes(":")) {
    // IPv6：loopback、unspecified、link-local、ULA、IPv4-mapped/compatible
    if (normalized === "::1") return true;
    if (normalized === "::") return true; // unspecified（0.0.0.0 等价）
    if (normalized.startsWith("fe80:")) return true;
    if (/^f[cd]/.test(normalized)) return true;
    // WHATWG URL 会把 IPv4-mapped 归一化为 hex 形式
    // （[::ffff:127.0.0.1] → [::ffff:7f00:1]），点分正则命中不了，必须按 hex 段解析
    const mappedHex = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) return isPrivateV4(hexPairToV4(mappedHex[1], mappedHex[2]));
    // 兼容形式 ::a.b.c.d 同样被归一化为 ::xxxx:xxxx（前 96 位为 0）
    const compatHex = normalized.match(/^::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (compatHex) return isPrivateV4(hexPairToV4(compatHex[1], compatHex[2]));
    // 直接传入（非 URL 归一化）时仍可能是点分形式
    const mappedDotted = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mappedDotted ? isPrivateV4(mappedDotted[1]) : false;
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(normalized)) return isPrivateV4(normalized);
  return normalized === "localhost";
}

// 已知限制：不做 DNS 解析，指向内网的域名可通过（本地单用户场景威胁有限）
function isAllowedBaseUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    // new URL 的 hostname 对 IPv6 保留方括号（"[::1]"），先剥掉再比较
    const hostname = parsed.hostname;
    if (isPrivateIp(hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

export async function registerComputeRoutes(app: FastifyInstance, context: ApiContext) {
  app.get("/compute/providers", {
    schema: { summary: "List compute providers", tags: ["compute"] },
  }, async () => {
    const config = await context.configRepository.load();
    return config.providers.map((p) => ({ ...p, apiKey: p.apiKey ? "***" : undefined }));
  });

  app.post("/compute/providers", {
    schema: { summary: "Create a compute provider", tags: ["compute"] },
  }, async (request, reply) => {
    const body = request.body as {
      id?: string;
      displayName: string;
      providerType?: string;
      baseUrl: string;
      apiKey?: string;
      apiMode?: string;
      models?: unknown[];
    };
    if (!isAllowedBaseUrl(body.baseUrl)) {
      return reply.status(400).send({ error: "Invalid baseUrl" });
    }
    if (body.apiMode !== undefined && !isApiMode(body.apiMode)) {
      return reply.status(400).send({
        error: "Invalid apiMode（只允许 responses / anthropic / chat_completions）",
      });
    }
    const config = await context.configRepository.load();
    const provider = {
      id: body.id || crypto.randomUUID(),
      displayName: body.displayName,
      providerType: (body.providerType || "openai") as "openai",
      baseUrl: body.baseUrl,
      apiKey: body.apiKey,
      ...(body.apiMode !== undefined ? { apiMode: body.apiMode } : {}),
      models: (body.models || []) as { id: string; displayName: string; modelType: "llm" | "embedding" | "image" | "stt" }[],
    };
    config.providers.push(provider);
    await context.configRepository.save(config);
    return sanitizeProvider(provider);
  });

  app.put("/compute/providers/:id", {
    schema: { summary: "Update a compute provider", tags: ["compute"] },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as Partial<{
      displayName: string;
      baseUrl: string;
      apiKey: string;
      apiMode: string;
    }>;
    if (body.baseUrl !== undefined && !isAllowedBaseUrl(body.baseUrl)) {
      return reply.status(400).send({ error: "Invalid baseUrl" });
    }
    if (body.apiMode !== undefined && !isApiMode(body.apiMode)) {
      return reply.status(400).send({
        error: "Invalid apiMode（只允许 responses / anthropic / chat_completions）",
      });
    }
    const config = await context.configRepository.load();
    const idx = config.providers.findIndex((p) => p.id === id);
    if (idx < 0) return reply.status(404).send({ error: "Provider not found" });
    const existing = config.providers[idx];
    config.providers[idx] = {
      ...existing,
      displayName: body.displayName ?? existing.displayName,
      baseUrl: body.baseUrl ?? existing.baseUrl,
      apiMode: body.apiMode ?? existing.apiMode,
      // 空字符串视为"不修改"，避免编辑表单清空已保存的密钥
      apiKey: body.apiKey || existing.apiKey,
    };
    await context.configRepository.save(config);
    return sanitizeProvider(config.providers[idx]);
  });

  app.delete("/compute/providers/:id", {
    schema: { summary: "Delete a compute provider", tags: ["compute"] },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const config = await context.configRepository.load();
    config.providers = config.providers.filter((p) => p.id !== id);
    await context.configRepository.save(config);
    return reply.status(204).send();
  });

  app.post("/compute/providers/:id/test", {
    schema: { summary: "Test a compute provider connection", tags: ["compute"] },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const config = await context.configRepository.load();
    const provider = config.providers.find((p) => p.id === id);
    if (!provider) return reply.status(404).send({ error: "Provider not found" });
    try {
      const client = new OpenAI({ apiKey: provider.apiKey, baseURL: provider.baseUrl });
      const models = await client.models.list();
      const discovered = models.data.map((m) => ({
        id: m.id,
        displayName: m.id,
        modelType: "llm" as const,
      }));
      return { ok: true, discovered };
    } catch (err) {
      logger.error({ err: err }, "test connection failed");
      return reply.status(502).send({ error: "Test connection failed" });
    }
  });

  app.get("/compute/usage", {
    schema: { summary: "Get compute usage statistics", tags: ["compute"] },
  }, async () => {
    return aggregateUsage();
  });

  app.post("/compute/providers/:id/models", {
    schema: { summary: "Add a model to a provider", tags: ["compute"] },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as Record<string, unknown>;
    const config = await context.configRepository.load();
    const provider = config.providers.find((p) => p.id === id);
    if (!provider) return reply.status(404).send({ error: "Provider not found" });
    provider.models.push(body as { id: string; displayName: string; modelType: "llm" | "embedding" | "image" | "stt" });
    await context.configRepository.save(config);
    return body;
  });

  app.put("/compute/providers/:id/models/:modelId", {
    schema: { summary: "Update a provider model", tags: ["compute"] },
  }, async (request, reply) => {
    const { id, modelId } = request.params as { id: string; modelId: string };
    const body = request.body as Record<string, unknown>;
    const config = await context.configRepository.load();
    const provider = config.providers.find((p) => p.id === id);
    if (!provider) return reply.status(404).send({ error: "Provider not found" });
    const idx = provider.models.findIndex((m) => m.id === modelId);
    if (idx < 0) return reply.status(404).send({ error: "Model not found" });
    provider.models[idx] = { ...provider.models[idx], ...body };
    await context.configRepository.save(config);
    return provider.models[idx];
  });

  app.delete("/compute/providers/:id/models/:modelId", {
    schema: { summary: "Delete a provider model", tags: ["compute"] },
  }, async (request, reply) => {
    const { id, modelId } = request.params as { id: string; modelId: string };
    const config = await context.configRepository.load();
    const provider = config.providers.find((p) => p.id === id);
    if (!provider) return reply.status(404).send({ error: "Provider not found" });
    provider.models = provider.models.filter((m) => m.id !== modelId);
    await context.configRepository.save(config);
    return reply.status(204).send();
  });
}
