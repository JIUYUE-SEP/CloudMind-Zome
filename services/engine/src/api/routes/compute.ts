import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { isIP } from "node:net";
import { logger } from "../../logger.js";
import type { FastifyInstance } from "fastify";
import type { ApiContext } from "../context.js";
import type { ModelInfo, ProviderConfig } from "@mindcloud/shared";
import OpenAI from "openai";
import { isApiMode } from "../../provider/protocols/index.js";
import {
  ANTHROPIC_VERSION,
  anthropicModelsUrl,
  isRecord,
} from "../../provider/protocols/shared.js";

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
 * 型号条目白名单构造（A4：POST /providers 的 models 数组与 POST/PUT
 * /models 端点同口径）：
 * - id 非空（trim 后）；
 * - displayName 提供了就必须非空（缺省回退 modelId，与型号端点一致）；
 * - modelType 白名单（llm/embedding/image/stt）；
 * - contextWindow/maxOutputTokens 可选正整数；
 * - supports* 可选布尔；
 * - apiMode 三族白名单（responses/anthropic/chat_completions）。
 * 非法返回带字段名的错误文案；合法返回白名单构造的 ModelInfo。
 */
function buildModelFromBody(
  body: Record<string, unknown>,
): { ok: true; model: ModelInfo } | { ok: false; error: string } {
  const modelId = typeof body.id === "string" ? body.id.trim() : "";
  if (!modelId) return { ok: false, error: "id is required" };
  if (
    body.displayName !== undefined &&
    (typeof body.displayName !== "string" || body.displayName.trim() === "")
  ) {
    return { ok: false, error: "displayName must be a non-empty string" };
  }
  if (
    typeof body.modelType !== "string" ||
    !(MODEL_TYPES as readonly string[]).includes(body.modelType)
  ) {
    return { ok: false, error: "Invalid modelType（只允许 llm / embedding / image / stt）" };
  }
  for (const field of ["contextWindow", "maxOutputTokens"] as const) {
    const validationError = validateOptionalPositiveIntNoMax(body[field], field);
    if (validationError) return { ok: false, error: validationError };
  }
  for (const field of ["supportsReasoning", "supportsToolCalling", "supportsMultimodal"] as const) {
    const validationError = validateOptionalBoolean(body[field], field);
    if (validationError) return { ok: false, error: validationError };
  }
  if (body.apiMode !== undefined && !isApiMode(body.apiMode)) {
    return { ok: false, error: "Invalid apiMode（只允许 responses / anthropic / chat_completions）" };
  }
  return {
    ok: true,
    model: {
      id: modelId,
      displayName:
        typeof body.displayName === "string" && body.displayName ? body.displayName : modelId,
      modelType: body.modelType as ModelInfo["modelType"],
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
      ...(body.apiMode !== undefined ? { apiMode: body.apiMode as ModelInfo["apiMode"] } : {}),
    },
  };
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

/**
 * P1-7：PUT/DELETE provider 后退役引用它的 worker（主算力链 + 降级链）。
 * 与 agent 配置 onChange 的 retire 路径同语义：下一次 getOrCreate 按活配置
 * 重建 provider 链（改 key/协议/超时即刻生效；删除后走 createLLMProvider 的
 * "provider 不存在" 明确报错，而不是 Router 回落创建时快照继续打旧端点）。
 * H6：三个型号端点（POST/PUT/DELETE models）保存配置后同样调用——
 * hasModelApiModeOverride 只在 worker/Provider 实例创建时判定一次，
 * 型号级 apiMode 覆盖的新增/变更/删除必须退役重建才会即刻生效。
 */
async function retireWorkersUsingProvider(context: ApiContext, providerId: string): Promise<void> {
  if (!context.retireAgentWorker) return;
  const agents = await context.agentRepository.list();
  for (const agent of agents) {
    if (
      agent.providerId === providerId ||
      (agent.fallbackProviderIds ?? []).includes(providerId)
    ) {
      context.retireAgentWorker(agent.id);
    }
  }
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

const DNS_LOOKUP_TIMEOUT_MS = 3_000;

/**
 * 带请求级超时的 dns.lookup（all:true，A/AAAA 全记录；verbatim:false 交由系统
 * 排序——此处逐条全量判定，不依赖返回顺序）。dns.promises.lookup 无超时选项，
 * 用 Promise.race 兜底：超时按解析失败 reject，由调用方走统一失败语义。
 * 计时器 unref 不拖住进程退出；race 不取消底层 lookup，悬挂结果随后被丢弃。
 */
function lookupAllWithTimeout(hostname: string): Promise<LookupAddress[]> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    lookup(hostname, { all: true, verbatim: false }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(Object.assign(new Error("DNS lookup timeout"), { code: "ETIMEOUT" })),
        DNS_LOOKUP_TIMEOUT_MS,
      );
      timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * baseUrl SSRF 校验：协议白名单 + 内网地址判定。
 * - IP 字面量：直接过 isPrivateIp（IPv6 归一化、::ffff: hex 形式等见该函数），
 *   不触发 DNS 解析；
 * - 主机名：DNS 解析全部 A/AAAA 记录，逐地址过同一份 isPrivateIp 判定，
 *   任一记录落内网即拒绝（堵「域名指向内网」绕过）。
 * 每次调用各解析一次、不做缓存：配置变更频率低，缓存反而引入陈旧记录风险。
 *
 * 失败语义（显式选择）：DNS 解析失败（NXDOMAIN / 超时 / 离线）→ 放行 + warn。
 * 理由：本地单用户场景，离线环境下合法主机名（内网穿透域名、私有 DNS 记录）
 * 不能被误杀；真正发起请求时连不上，自有 test-connection / 调用链报错兜底。
 * 已知残余风险（如实写明）：
 * - DNS rebinding 的 TOCTOU：校验时刻解析为公网、实际连接时记录已切换为内网
 *   的情形不在防范围内——本校验只覆盖「配置时解析结果含内网地址」这一档；
 * - 解析失败的放行窗口可被恶意域名利用（权衡后接受，理由见上）。
 */
async function isAllowedBaseUrl(url: string): Promise<boolean> {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    // new URL 的 hostname 对 IPv6 保留方括号（"[::1]"），先剥掉再判定
    const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
    if (isPrivateIp(hostname)) return false;
    // IP 字面量（v4/v6）：上面的 isPrivateIp 已是完整判定，无需 DNS 解析
    if (isIP(hostname) !== 0) return true;
    try {
      const addresses = await lookupAllWithTimeout(hostname);
      // 逐地址与 IP 字面量走同一份内网判定，任一落内网即拒绝
      for (const { address } of addresses) {
        if (isPrivateIp(address)) return false;
      }
      return true;
    } catch (err) {
      // 解析失败 → 放行 + warn（选择与理由见函数头注释）
      logger.warn(
        { hostname, errCode: (err as NodeJS.ErrnoException).code },
        "baseUrl DNS resolution failed, allowing anyway",
      );
      return true;
    }
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
    // M28：无 body/无 content-type 时 request.body 为 undefined，?? {} 兜底避免 TypeError 500（同 plans.ts 口径）
    const body = (request.body ?? {}) as {
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
    // F5：displayName 空串/纯空白拒绝（否则落档 providerName="" 会被 usage 聚合归入 unknown）
    if (typeof body.displayName !== "string" || body.displayName.trim() === "") {
      return reply.status(400).send({ error: "displayName must be a non-empty string" });
    }
    // providerType 白名单（对齐 shared ProviderConfig.providerType 枚举，当前仅
    // "openai"）——非法值 400，不再带脏值落库（类型上是 "openai" 字面量，落库
    // 后消费方按枚举处理）；缺省/空串维持既有口径落 "openai"
    if (body.providerType !== undefined && body.providerType !== "" && body.providerType !== "openai") {
      return reply.status(400).send({ error: "Invalid providerType（只允许 openai）" });
    }
    if (!(await isAllowedBaseUrl(body.baseUrl))) {
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
    // A4：models 数组逐型号走与型号端点同口径校验——非法 400，杜绝
    // contextWindow:"abc"→NaN 静默禁用撞顶、非法 apiMode 静默落库等路径
    const models: ModelInfo[] = [];
    const seenModelIds = new Set<string>();
    if (body.models !== undefined) {
      if (!Array.isArray(body.models)) {
        return reply.status(400).send({ error: "models must be an array" });
      }
      for (const rawModel of body.models) {
        if (!isRecord(rawModel)) {
          return reply.status(400).send({ error: "models entries must be objects" });
        }
        const built = buildModelFromBody(rawModel);
        if (!built.ok) return reply.status(400).send({ error: built.error });
        // P3：同 id 两型号落库会歧义 (providerId, modelId) Router 缓存键——400 拒绝
        if (seenModelIds.has(built.model.id)) {
          return reply.status(400).send({ error: `Duplicate model id: ${built.model.id}` });
        }
        seenModelIds.add(built.model.id);
        models.push(built.model);
      }
    }
    const provider = {
      id: body.id || crypto.randomUUID(),
      displayName: body.displayName,
      providerType: (body.providerType || "openai") as "openai",
      baseUrl: body.baseUrl,
      apiKey: body.apiKey,
      ...(body.apiMode !== undefined ? { apiMode: body.apiMode } : {}),
      ...(body.requestTimeout !== undefined ? { requestTimeout: body.requestTimeout } : {}),
      ...(body.maxRetries !== undefined ? { maxRetries: body.maxRetries } : {}),
      models,
    };
    // M33：显式 id 查重（对照 POST /agents 的 409 口径）——同 id 落两条配置会让
    // agent.providerId 引用歧义。注：API.md 记载的「无重复校验」已过时，文档同步由主线处理
    // 读-改-写走 update（写队列内读最新再改再写）：并发 POST 不再互丢 provider；
    // mutator 返回原因码 = 放弃落盘（404/409 类前置失败不落盘）
    const { result } = await context.configRepository.update((config) => {
      if (body.id && config.providers.some((p) => p.id === body.id)) {
        return "conflict" as const;
      }
      config.providers.push(provider);
    });
    if (result === "conflict") {
      return reply.status(409).send({ error: `Provider id already exists: ${body.id}` });
    }
    return sanitizeProvider(provider);
  });

  app.put("/compute/providers/:id", {
    schema: { summary: "Update a compute provider", tags: ["compute"] },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Partial<{
      displayName: string;
      baseUrl: string;
      apiKey: string;
      apiMode: string;
      requestTimeout: number;
      maxRetries: number;
    }>;
    // M33：PUT 与 POST 同口径（F5）——?? 只挡 undefined，空串/纯空白 displayName 会覆盖落库
    if (
      body.displayName !== undefined &&
      (typeof body.displayName !== "string" || body.displayName.trim() === "")
    ) {
      return reply.status(400).send({ error: "displayName must be a non-empty string" });
    }
    if (body.baseUrl !== undefined && !(await isAllowedBaseUrl(body.baseUrl))) {
      return reply.status(400).send({ error: "Invalid baseUrl" });
    }
    if (body.apiMode !== undefined && !isApiMode(body.apiMode)) {
      return reply.status(400).send({
        error: "Invalid apiMode（只允许 responses / anthropic / chat_completions）",
      });
    }
    // isApiMode 谓词把 body.apiMode 收窄为 ProtocolApiMode|undefined，但属性收窄
    // 不继承进下面的 update 闭包——提为 const（const 初始化收窄闭包内有效）
    const bodyApiMode = body.apiMode;
    const requestTimeoutError = validateOptionalPositiveInt(body.requestTimeout, "requestTimeout", 600_000);
    if (requestTimeoutError) {
      return reply.status(400).send({ error: requestTimeoutError });
    }
    const maxRetriesError = validateOptionalPositiveInt(body.maxRetries, "maxRetries", 10);
    if (maxRetriesError) {
      return reply.status(400).send({ error: maxRetriesError });
    }
    // 读-改-写走 update（写队列内读最新再改再写），跨请求不互丢更新
    let updated: ProviderConfig | undefined;
    const { result } = await context.configRepository.update((config) => {
      const idx = config.providers.findIndex((p) => p.id === id);
      if (idx < 0) return "not-found" as const; // 404：放弃修改，不落盘
      const existing = config.providers[idx];
      const next: ProviderConfig = {
        ...existing,
        displayName: body.displayName ?? existing.displayName,
        baseUrl: body.baseUrl ?? existing.baseUrl,
        apiMode: bodyApiMode ?? existing.apiMode,
        requestTimeout: body.requestTimeout ?? existing.requestTimeout,
        maxRetries: body.maxRetries ?? existing.maxRetries,
        // 空字符串与 GET 掩码 "***" 均视为"不修改"（同 config.ts 口径）——
        // 前者避免编辑表单清空已存密钥，后者防止掩码回写被当真 key 加密落库；
        // "清除已存 key" 通道维持不开放（保持现状不动）
        apiKey: body.apiKey && body.apiKey !== "***" ? body.apiKey : existing.apiKey,
      };
      config.providers[idx] = next;
      updated = next;
    });
    if (result === "not-found") return reply.status(404).send({ error: "Provider not found" });
    await retireWorkersUsingProvider(context, id);
    return sanitizeProvider(updated!);
  });

  app.delete("/compute/providers/:id", {
    schema: { summary: "Delete a compute provider", tags: ["compute"] },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    // F10：不存在按 404（与同文件 PUT 口径一致），不再恒 204；
    // 404 时不落盘也不触发 worker 退役副作用
    const { result } = await context.configRepository.update((config) => {
      if (!config.providers.some((p) => p.id === id)) return "not-found" as const;
      config.providers = config.providers.filter((p) => p.id !== id);
    });
    if (result === "not-found") return reply.status(404).send({ error: "Provider not found" });
    await retireWorkersUsingProvider(context, id);
    return reply.status(204).send();
  });

  app.post("/compute/providers/:id/test", {
    schema: { summary: "Test a compute provider connection", tags: ["compute"] },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const config = await context.configRepository.load();
    const provider = config.providers.find((p) => p.id === id);
    if (!provider) return reply.status(404).send({ error: "Provider not found" });
    // M33：OpenAI 族无 apiKey 时 SDK 构造即抛错，会被下面 catch 误报 502 上游故障——
    // 前置 400 明确文案（anthropic 路径走裸 fetch，无 key 由上游 401 正常归类，不拦截）
    if (provider.apiMode !== "anthropic" && !provider.apiKey) {
      return reply.status(400).send({ error: "apiKey required（该 provider 未配置密钥，无法测试连接）" });
    }
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
      // A2/F2 隐私收敛：只落 describeUpstreamError 的固定分类文案 +
      // status/kind + 标识字段，绝不落 errMessage 原文——上游错误体经常把
      // Authorization/密钥回显进 message，原文进日志即泄密（客户端响应侧
      // describeUpstreamError 同样只给固定文案）。
      const statusCode =
        typeof err === "object" && err !== null
          ? (err as { status?: unknown }).status
          : undefined;
      const kind =
        typeof err === "object" && err !== null
          ? (err as { kind?: unknown }).kind
          : undefined;
      logger.error(
        {
          errorSummary: describeUpstreamError(err),
          ...(typeof statusCode === "number" ? { statusCode } : {}),
          ...(kind === "protocol" ? { kind } : {}),
          providerId: id,
          apiMode: provider.apiMode,
        },
        "test connection failed",
      );
      return reply.status(502).send({ error: `Test connection failed: ${describeUpstreamError(err)}` });
    }
  });

  app.get("/compute/usage", {
    schema: { summary: "Get compute usage statistics", tags: ["compute"] },
  }, async (request, reply) => {
    // P6 复审加固（fail-closed）：compute 未装配时显式 500 带原因（agents.ts P5 先例；
    // 该路由的 compute 消费点只此一处，已同口径）
    if (!context.compute) {
      return reply.status(500).send({ error: "compute service not assembled (ApiContext.compute missing)" });
    }
    // P5：usage 消费改经 ApiContext 从 ctx.compute 透传（原 compute/usage 直 import 已切）
    return context.compute.aggregateUsage();
  });

  app.post("/compute/providers/:id/models", {
    schema: { summary: "Add a model to a provider", tags: ["compute"] },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const built = buildModelFromBody(body);
    if (!built.ok) return reply.status(400).send({ error: built.error });
    const model = built.model;
    // 读-改-写走 update：存在性/查重/落盘同一队列槽位，并发写不互丢
    const { result } = await context.configRepository.update((config) => {
      const provider = config.providers.find((p) => p.id === id);
      if (!provider) return "no-provider" as const; // 404/409：放弃修改，不落盘
      if (provider.models.some((m) => m.id === model.id)) {
        return "dup" as const;
      }
      provider.models.push(model);
    });
    if (result === "no-provider") return reply.status(404).send({ error: "Provider not found" });
    if (result === "dup") {
      return reply.status(409).send({ error: `Model id already exists: ${model.id}` });
    }
    // H6：新增型号同样可能引入首个型号级 apiMode 覆盖，退役重建即刻生效
    await retireWorkersUsingProvider(context, id);
    return model;
  });

  app.put("/compute/providers/:id/models/:modelId", {
    schema: { summary: "Update a provider model", tags: ["compute"] },
  }, async (request, reply) => {
    const { id, modelId } = request.params as { id: string; modelId: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
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
    // R4：apiMode=null 表示显式清除型号级覆盖（回退 provider 级）；白名单只约束非空值
    const rawApiMode = body.apiMode;
    if (rawApiMode !== undefined && rawApiMode !== null && !isApiMode(rawApiMode)) {
      return reply.status(400).send({
        error: "Invalid apiMode（只允许 responses / anthropic / chat_completions）",
      });
    }
    // 读-改-写走 update：404 判定与落盘同一队列槽位，并发写不互丢
    let updatedModel: ModelInfo | undefined;
    const { result: skipReason } = await context.configRepository.update((config) => {
      const provider = config.providers.find((p) => p.id === id);
      if (!provider) return "no-provider" as const; // 404：放弃修改，不落盘
      const idx = provider.models.findIndex((m) => m.id === modelId);
      if (idx < 0) return "no-model" as const;
      const existing = provider.models[idx];
      const updated: ModelInfo = {
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
      if (rawApiMode === null) {
        // R4：显式清除型号级覆盖，后续 chat 回落 provider 级 apiMode
        delete updated.apiMode;
      } else if (rawApiMode !== undefined) {
        updated.apiMode = rawApiMode as ModelInfo["apiMode"];
      }
      provider.models[idx] = updated;
      updatedModel = updated;
    });
    if (skipReason === "no-provider") return reply.status(404).send({ error: "Provider not found" });
    if (skipReason === "no-model") return reply.status(404).send({ error: "Model not found" });
    // H6：型号级 apiMode 覆盖变更（含 null 清除）需退役重建 worker 即刻生效
    await retireWorkersUsingProvider(context, id);
    return updatedModel;
  });

  app.delete("/compute/providers/:id/models/:modelId", {
    schema: { summary: "Delete a provider model", tags: ["compute"] },
  }, async (request, reply) => {
    const { id, modelId } = request.params as { id: string; modelId: string };
    // F10：provider 不存在 / 型号未命中都按 404（与同文件 PUT model 口径一致），
    // 不再恒 204；404 时不落盘也不触发 worker 退役副作用
    const { result: skipReason } = await context.configRepository.update((config) => {
      const provider = config.providers.find((p) => p.id === id);
      if (!provider) return "no-provider" as const;
      if (!provider.models.some((m) => m.id === modelId)) return "no-model" as const;
      provider.models = provider.models.filter((m) => m.id !== modelId);
    });
    if (skipReason === "no-provider") return reply.status(404).send({ error: "Provider not found" });
    if (skipReason === "no-model") return reply.status(404).send({ error: "Model not found" });
    // H6：删除型号可能移除最后一个型号级 apiMode 覆盖，退役重建即刻生效
    await retireWorkersUsingProvider(context, id);
    return reply.status(204).send();
  });
}
