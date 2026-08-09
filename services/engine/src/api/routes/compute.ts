import { logger } from "../../logger.js";
import type { FastifyInstance } from "fastify";
import type { ApiContext } from "../context.js";
import type { ModelInfo } from "@mindcloud/shared";
import OpenAI from "openai";
import { aggregateUsage } from "../../compute/usage.js";
import { isApiMode } from "../../provider/protocols/index.js";
import { ANTHROPIC_VERSION, anthropicModelsUrl } from "../../provider/protocols/shared.js";

const MODEL_TYPES = ["llm", "embedding", "image", "stt"] as const;

/** 可选正整数校验：缺省放行；非法返回带字段名的错误文案 */
function validateOptionalPositiveInt(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > max) {
    return `${field} must be a positive integer no greater than ${max}`;
  }
  return undefined;
}

/** 可选正整数校验（无上限）：型号能力字段用 */
function validateOptionalPositiveIntNoMax(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return `${field} must be a positive integer`;
  }
  return undefined;
}

/** 可选布尔校验：缺省放行；非法返回带字段名的错误文案 */
function validateOptionalBoolean(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") return `${field} must be a boolean`;
  return undefined;
}

/**
 * Anthropic 语义连接测试：GET {baseUrl}/anthropic/v1/models（路径归一与
 * anthropicMessagesUrl 同源），x-api-key + anthropic-version 认证，与
 * AnthropicMessagesProvider 的请求约定保持一致。返回型号 id 列表。
 */
async function testAnthropicConnection(provider: {
  apiKey?: string;
  baseUrl: string;
  requestTimeout?: number;
}): Promise<ModelInfo[]> {
  const headers: Record<string, string> = { "anthropic-version": ANTHROPIC_VERSION };
  if (provider.apiKey) headers["x-api-key"] = provider.apiKey;
  const response = await fetch(anthropicModelsUrl(provider.baseUrl), {
    method: "GET",
    headers,
    // R3（review）：超时受控，避免 Web 端断开后 engine 侧 fetch 无限悬挂
    signal: AbortSignal.timeout(provider.requestTimeout ?? 30_000),
  });
  if (!response.ok) {
    const err = new Error(
      `Anthropic models endpoint returned HTTP ${response.status}`,
    ) as Error & { status?: number };
    err.status = response.status;
    throw err;
  }
  let body: { data?: Array<{ id?: unknown }> };
  try {
    body = (await response.json()) as { data?: Array<{ id?: unknown }> };
  } catch {
    const err = new Error(
      "Anthropic models endpoint returned non-JSON body",
    ) as Error & { kind?: "protocol" };
    err.kind = "protocol";
    throw err;
  }
  if (!Array.isArray(body.data)) {
    const err = new Error(
      "Anthropic models endpoint returned no data list",
    ) as Error & { kind?: "protocol" };
    err.kind = "protocol";
    throw err;
  }
  return body.data
    .filter((m) => typeof m?.id === "string" && m.id.length > 0)
    .map((m) => ({ id: m.id as string, displayName: m.id as string, modelType: "llm" as const }));
}

/**
 * 测试连接失败归类（R2）：上游 HTTP 错误带 status 并给出固定概括文案，
 * 不截取上游 body 原文、不泄漏 apiKey；网络错误/超时/协议错误与 HTTP 可区分。
 */
function describeUpstreamError(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const candidate = err as { status?: unknown; name?: unknown; kind?: unknown };
    if (typeof candidate.status === "number") {
      if (candidate.status === 401 || candidate.status === 403) {
        return `上游返回 ${candidate.status}（密钥无效或权限不足）`;
      }
      if (candidate.status === 404) {
        return `上游返回 ${candidate.status}（无 models 端点）`;
      }
      return `上游返回 ${candidate.status}`;
    }
    if (candidate.kind === "protocol") {
      return "上游响应格式错误（非 JSON 或缺少 data 列表）";
    }
    if (
      candidate.name === "TimeoutError" ||
      candidate.name === "AbortError" ||
      (typeof candidate.name === "string" && candidate.name.includes("Timeout"))
    ) {
      return "上游请求超时";
    }
  }
  return "网络错误（无法连接上游）";
}

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
      requestTimeout?: number;
      maxRetries?: number;
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
    const requestTimeoutError = validateOptionalPositiveInt(body.requestTimeout, "requestTimeout", 600_000);
    if (requestTimeoutError) {
      return reply.status(400).send({ error: requestTimeoutError });
    }
    const maxRetriesError = validateOptionalPositiveInt(body.maxRetries, "maxRetries", 10);
    if (maxRetriesError) {
      return reply.status(400).send({ error: maxRetriesError });
    }
    const config = await context.configRepository.load();
    const provider = {
      id: body.id || crypto.randomUUID(),
      displayName: body.displayName,
      providerType: (body.providerType || "openai") as "openai",
      baseUrl: body.baseUrl,
      apiKey: body.apiKey,
      ...(body.apiMode !== undefined ? { apiMode: body.apiMode } : {}),
      ...(body.requestTimeout !== undefined ? { requestTimeout: body.requestTimeout } : {}),
      ...(body.maxRetries !== undefined ? { maxRetries: body.maxRetries } : {}),
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
      requestTimeout: number;
      maxRetries: number;
    }>;
    if (body.baseUrl !== undefined && !isAllowedBaseUrl(body.baseUrl)) {
      return reply.status(400).send({ error: "Invalid baseUrl" });
    }
    if (body.apiMode !== undefined && !isApiMode(body.apiMode)) {
      return reply.status(400).send({
        error: "Invalid apiMode（只允许 responses / anthropic / chat_completions）",
      });
    }
    const requestTimeoutError = validateOptionalPositiveInt(body.requestTimeout, "requestTimeout", 600_000);
    if (requestTimeoutError) {
      return reply.status(400).send({ error: requestTimeoutError });
    }
    const maxRetriesError = validateOptionalPositiveInt(body.maxRetries, "maxRetries", 10);
    if (maxRetriesError) {
      return reply.status(400).send({ error: maxRetriesError });
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
      requestTimeout: body.requestTimeout ?? existing.requestTimeout,
      maxRetries: body.maxRetries ?? existing.maxRetries,
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
      const discovered =
        provider.apiMode === "anthropic"
          ? await testAnthropicConnection(provider)
          : (await new OpenAI({ apiKey: provider.apiKey, baseURL: provider.baseUrl }).models.list())
              .data.map((m) => ({
                id: m.id,
                displayName: m.id,
                modelType: "llm" as const,
              }));
      return { ok: true, discovered };
    } catch (err) {
      logger.error({ err: err, providerId: id, apiMode: provider.apiMode }, "test connection failed");
      return reply.status(502).send({ error: `Test connection failed: ${describeUpstreamError(err)}` });
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
    const modelId = typeof body.id === "string" ? body.id.trim() : "";
    if (!modelId) {
      return reply.status(400).send({ error: "id is required" });
    }
    if (provider.models.some((m) => m.id === modelId)) {
      return reply.status(409).send({ error: `Model id already exists: ${modelId}` });
    }
    if (typeof body.modelType !== "string" || !(MODEL_TYPES as readonly string[]).includes(body.modelType)) {
      return reply.status(400).send({
        error: "Invalid modelType（只允许 llm / embedding / image / stt）",
      });
    }
    for (const field of ["contextWindow", "maxOutputTokens"] as const) {
      const validationError = validateOptionalPositiveIntNoMax(body[field], field);
      if (validationError) return reply.status(400).send({ error: validationError });
    }
    for (const field of ["supportsReasoning", "supportsToolCalling", "supportsMultimodal"] as const) {
      const validationError = validateOptionalBoolean(body[field], field);
      if (validationError) return reply.status(400).send({ error: validationError });
    }
    const model: ModelInfo = {
      id: modelId,
      displayName:
        typeof body.displayName === "string" && body.displayName ? body.displayName : modelId,
      modelType: body.modelType as ModelInfo["modelType"],
      ...(body.contextWindow !== undefined ? { contextWindow: body.contextWindow as number } : {}),
      ...(body.maxOutputTokens !== undefined ? { maxOutputTokens: body.maxOutputTokens as number } : {}),
      ...(body.supportsReasoning !== undefined ? { supportsReasoning: body.supportsReasoning as boolean } : {}),
      ...(body.supportsToolCalling !== undefined ? { supportsToolCalling: body.supportsToolCalling as boolean } : {}),
      ...(body.supportsMultimodal !== undefined ? { supportsMultimodal: body.supportsMultimodal as boolean } : {}),
    };
    provider.models.push(model);
    await context.configRepository.save(config);
    return model;
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
    // R1（review）：PUT 校验与 POST 同口径——id 只能由路径决定，其余字段白名单构造，
    // 杜绝裸 spread 写非法 modelType / 字符串 contextWindow / 撞重复 id
    if (body.id !== undefined && body.id !== modelId) {
      return reply.status(400).send({ error: "id cannot be changed" });
    }
    if (
      body.displayName !== undefined &&
      (typeof body.displayName !== "string" || body.displayName.trim() === "")
    ) {
      return reply.status(400).send({ error: "displayName must be a non-empty string" });
    }
    if (
      body.modelType !== undefined &&
      (typeof body.modelType !== "string" || !(MODEL_TYPES as readonly string[]).includes(body.modelType))
    ) {
      return reply.status(400).send({
        error: "Invalid modelType（只允许 llm / embedding / image / stt）",
      });
    }
    for (const field of ["contextWindow", "maxOutputTokens"] as const) {
      const validationError = validateOptionalPositiveIntNoMax(body[field], field);
      if (validationError) return reply.status(400).send({ error: validationError });
    }
    for (const field of ["supportsReasoning", "supportsToolCalling", "supportsMultimodal"] as const) {
      const validationError = validateOptionalBoolean(body[field], field);
      if (validationError) return reply.status(400).send({ error: validationError });
    }
    const existing = provider.models[idx];
    provider.models[idx] = {
      ...existing,
      ...(body.displayName !== undefined ? { displayName: body.displayName as string } : {}),
      ...(body.modelType !== undefined ? { modelType: body.modelType as ModelInfo["modelType"] } : {}),
      ...(body.contextWindow !== undefined ? { contextWindow: body.contextWindow as number } : {}),
      ...(body.maxOutputTokens !== undefined ? { maxOutputTokens: body.maxOutputTokens as number } : {}),
      ...(body.supportsReasoning !== undefined
        ? { supportsReasoning: body.supportsReasoning as boolean }
        : {}),
      ...(body.supportsToolCalling !== undefined
        ? { supportsToolCalling: body.supportsToolCalling as boolean }
        : {}),
      ...(body.supportsMultimodal !== undefined
        ? { supportsMultimodal: body.supportsMultimodal as boolean }
        : {}),
    };
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
