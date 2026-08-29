import type { AgentConfig } from "@mindcloud/shared";
import type {
  ChatMessageRecord,
  HandoffUpdateFrame,
  ModelInfo,
  ProviderConfig,
  ScheduledTask,
} from "@mindcloud/shared";
import { DEFAULT_ENGINE_URL } from "@mindcloud/shared";
import { ref } from "vue";
import { fetchWithTimeout } from "@/utils/fetch";
import { resolveEngineToken, fetchEngineTokenFromServer } from "@/utils/engine-token";
import {
  createManagedWsConnection,
  type ManagedWsDeps,
  type WebSocketHandlers,
  type Connection,
} from "@/utils/managed-ws";

// REST DTO 权威定义在 packages/shared（P5-2 收敛），此处再导出保持既有引用不变
// （ScheduledTask 由 stores/scheduler.ts 再导出，避免 Nuxt 自动导入重名告警）
export type { ChatMessageRecord, ModelInfo };
export type Provider = ProviderConfig;
// WS 处理器/连接句柄类型（WebSocketHandlers/Connection）权威定义在 utils/managed-ws
// （D2 收敛：连接生命周期单点），本文件不再再导出——Nuxt 自动导入会与源头撞名告警

export interface MemorySettings {
  compactThreshold: number;
  keepRecent: number;
  hotMemoryLimit: number;
  warmMemoryLimit: number;
}

export interface AppSettings {
  tavilyApiKey?: string;
  /** sidecar 自启唤醒（缺省 false） */
  sidecarAutoStart?: boolean;
  memory: MemorySettings;
}

export interface ToolInfo {
  name: string;
  toolset: string;
  safeToParallel: boolean;
}

export interface EngineLogEntry {
  time: number;
  level: number;
  msg: string;
}

// ---- blurb 管理 v3（/agents/:id/tool-catalog + /tool-blurbs）契约镜像：
// services/engine/src/core/tool-catalog-service.ts（web 不依赖 engine 包，本地镜像） ----
/** status 四态（builtin 恒 "core" 无管理面） */
export type ToolBlurbStatus = "llm" | "user" | "missing" | "stale";
export interface ToolCatalogDynamicItem {
  name: string;
  blurb: string;
  source?: "llm" | "user";
  status: ToolBlurbStatus;
}
export interface ToolCatalogSkillItem {
  name: string;
  /** 作者行（SKILL.md description 原文） */
  authorLine: string;
  /** 覆盖行（skill:<name> 条目 blurb） */
  overrideBlurb?: string;
  source?: "llm" | "user";
  status: ToolBlurbStatus;
}
export interface ToolCatalogBuiltinItem {
  name: string;
  blurb: string;
  status: "core";
}
export interface ToolCatalog {
  dynamic: ToolCatalogDynamicItem[];
  skills: ToolCatalogSkillItem[];
  builtin: ToolCatalogBuiltinItem[];
}
export interface ToolBlurbRegenerateResult {
  generated: string[];
  failed: string[];
  /** user 条目跳过不碰 */
  skipped: string[];
}
export interface ToolBlurbEntry {
  blurb: string;
  descHash: string;
  source: "llm" | "user";
  updatedAt: string;
}

export interface Session {
  id: string;
  name: string;
  agentIds: string[];
  type: "group" | "intermind";
  createdAt: string;
  updatedAt: string;
}

/** 消息分页参数（私聊 /chat/:agentId/messages 与群聊 /sessions/:id/messages 同口径） */
export interface MessagePageOptions {
  limit?: number;
  /** 消息 id 游标：取游标之前的一页，游标本身不含；缺省拉最新一页 */
  before?: string;
}

// ---- /plugins 与 /system/info 响应类型：与 engine 侧契约对齐 ----
// （plugins: services/engine/src/plugins/external/index.ts 的 ExternalFace；
//   system: services/engine/src/api/routes/system.ts，web 不依赖 engine 包，本地镜像）

/** 外部插件跳过原因（engine SkipReason 契约镜像，取值勿随意改） */
export type PluginSkipReason =
  | "disabled"
  | "invalid-entry"
  | "missing-entry"
  | "import-failed"
  | "no-apply"
  | "invalid-name"
  | "name-mismatch"
  | "mount-failed"
  | "apply-failed"
  | "pending";

export interface SkippedPlugin {
  name: string;
  reason: PluginSkipReason;
}

export interface PerAgentPluginResult {
  agentId: string;
  name: string;
  status: "loaded" | PluginSkipReason;
}

/** GET /plugins 响应（engine ExternalFace 镜像） */
export interface PluginLoadResult {
  loaded: string[];
  skipped: SkippedPlugin[];
  perAgent: PerAgentPluginResult[];
}

// ---- /plugins/manifest 管理面类型：engine 契约在 services/engine/src/plugins/external/manifest.ts
// （ManifestEntryView / ManifestPatch / readGlobalManifest / readAgentManifest），web 不依赖 engine 包，本地镜像 ----

/** 全局清单条目（engine ManifestEntryView 镜像 + hasEntry 恒 true：有清单条目） */
export interface PluginManifestEntry {
  name: string;
  enabled: boolean;
  config: Record<string, unknown>;
  hasEntry: true;
}

/** GET /plugins/manifest 响应（engine readGlobalManifest 镜像）：清单条目 + 目录有 index.mjs 但未登记的名字 */
export interface PluginsManifest {
  plugins: PluginManifestEntry[];
  unregistered: string[];
}

/** 单条写补丁（engine ManifestPatch 镜像）：两字段至少其一；config 整体替换该条目原 config */
export interface PluginManifestPatch {
  enabled?: boolean;
  config?: Record<string, unknown>;
}

/** PUT 写响应（engine 写端点镜像）：无热重载（决策 5），requiresRestart 恒 true */
export interface PluginManifestUpdateResult {
  name: string;
  enabled: boolean;
  config: Record<string, unknown>;
  requiresRestart: boolean;
}

/** per-agent 清单条目（engine readAgentManifest 镜像，无 hasEntry） */
export interface AgentPluginManifestEntry {
  name: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

/** GET /agents/:id/plugins/manifest 响应 */
export interface AgentPluginsManifest {
  plugins: AgentPluginManifestEntry[];
}

/** GET /system/info 响应（无 git 的打包分发省略 gitCommit） */
export interface SystemInfo {
  version: string;
  gitCommit?: string;
  dataDir: string;
  port: number;
  uptimeSec: number;
  sidecar: { configured: boolean };
}

export interface HandoffRecord {
  id: string;
  agentId: string;
  sessionId: string;
  reason: "watermark";
  status: HandoffUpdateFrame["status"];
  shift: number;
  maxShifts: number;
  bookMessageId?: string;
  bookText: string;
  used: number;
  window: number;
  createdAt: number;
  updatedAt: number;
  resumeJobId?: string;
  abortReason?: string;
}

export interface BlueprintNode {
  id: string;
  type: "start" | "llm" | "tool" | "end";
  x: number;
  y: number;
  config?: Record<string, unknown>;
}

export interface BlueprintEdge {
  source: string;
  target: string;
}

export interface Blueprint {
  id: string;
  name: string;
  nodes: BlueprintNode[];
  edges: BlueprintEdge[];
  createdAt: string;
  updatedAt: string;
}

export interface BlueprintExecution {
  id: string;
  blueprintId: string;
  status: "pending" | "running" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
  outputs: Record<string, unknown>;
  logs: string[];
}

export interface EngineClientOptions {
  baseUrl?: string;
}

// engine 的失败响应通常携带 { error } 正文（如 "Invalid agent id"、
// "invalid cron expression"），透出给调用方，避免错误语义被压成裸状态码
async function ensureOk(res: Response, action: string): Promise<void> {
  if (res.ok) return;
  let detail = "";
  try {
    const body: unknown = await res.json();
    if (body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string") {
      detail = (body as { error: string }).error;
    }
  } catch {
    // 非 JSON 响应体：退回状态码
  }
  throw new Error(detail ? `Failed to ${action}: ${detail}` : `Failed to ${action}: ${res.status}`);
}

// 模块级 backend URL 单例：模块加载即开始解析，结果缓存，
// 后续所有 useEngineClient() 调用直接复用，不再逐个 onMounted 异步获取。
// 默认地址的权威定义在 packages/shared（P5-2）
const sharedBaseUrl = ref(DEFAULT_ENGINE_URL);

// 模块级鉴权 token 单例（与 sharedBaseUrl 同一模式）。engine 本地 token 鉴权（P0-2）：
// 除 /health 外 REST 全部要求 Bearer，WS 握手要求子协议携带 token。
// 分发通道：web 开发默认由 nitro dev server 读 engine 数据目录 auth-token 文件经
// /api/engine-token 运行时下发（零配置）；NUXT_PUBLIC_ENGINE_TOKEN /
// localStorage["cloudmind.engineToken"] 仍是优先级更高的显式覆盖。
const sharedToken = ref("");

// token 就绪 Promise 单例（与 sharedToken 配套）：模块首次解析 token 时创建，
// engineFetch / WS 建连前 await 它，避免首屏请求抢跑 /api/engine-token 异步拉取
// （真机 #12）。就绪只等一次：后续请求直接复用已解析的 Promise，不重复拉 server。
let engineTokenReadyPromise: Promise<string> | null = null;

// A6/F4：token 失效（REST 401 / WS 4401 / 构造 SyntaxError）统一作废——
// 清内存就绪缓存 + 清 localStorage 陈旧 token，下次 resolve 走 server 档。
// 若只清内存不清 localStorage，陈旧本地 token 会在下一轮一票否决 server 档，
// 造成 401/4401 永锁；本函数把三条路径口径拉齐（与 WS SyntaxError 路径一致）。
function invalidateEngineToken(): void {
  engineTokenReadyPromise = null;
  sharedToken.value = "";
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.removeItem("cloudmind.engineToken");
    } catch {
      // 隐私模式等场景 localStorage 不可用：内存 token 已清，重取走 server 档
    }
  }
}

// baseUrl 尾部斜杠未归一会拼出 "//agents" 导致全部 404：赋值入口统一去除
function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

// 首次调用时从 runtimeConfig 取一次（NUXT_PUBLIC_ENGINE_URL 可覆盖），之后缓存复用
let runtimeConfigApplied = false;

export function useEngineClient(options?: EngineClientOptions) {
  const config = useRuntimeConfig();

  // token 解析链：应用 runtime 显式档/localStorage 档，
  // 前两档都缺时异步拉 server 档。返回的 Promise 由模块级就绪单例缓存，
  // 首次调用即开始，后续所有 engineFetch / WS 建连只等这一次
  async function resolveWebToken(): Promise<string> {
    if (!runtimeConfigApplied) {
      runtimeConfigApplied = true;
      if (config.public.engineUrl) sharedBaseUrl.value = normalizeBaseUrl(config.public.engineUrl as string);
    }
    const configuredToken = config.public.engineToken as string | undefined;
    let localToken: string | undefined;
    if (typeof localStorage !== "undefined") {
      try {
        localToken = localStorage.getItem("cloudmind.engineToken") ?? undefined;
      } catch {
        // 隐私模式等场景 localStorage 可能抛错：降级为未设置，走 server 档
        localToken = undefined;
      }
    }
    // 优先级：显式配置 > localStorage 覆盖 > server 自动读文件
    const initialToken = resolveEngineToken(configuredToken, localToken, undefined);
    sharedToken.value = initialToken;
    if (initialToken) return initialToken;
    if (typeof window === "undefined") return "";
    // 仅浏览器端异步拉 server 档（token 运行时下发，不进 bundle）
    const serverToken = await fetchEngineTokenFromServer();
    // 拉取期间用户显式配了 token：server token 不得覆盖更高优先级档
    if (serverToken && !sharedToken.value) sharedToken.value = serverToken;
    return sharedToken.value;
  }

  function ensureEngineTokenReady(): Promise<string> {
    if (!engineTokenReadyPromise) {
      engineTokenReadyPromise = resolveWebToken();
    }
    return engineTokenReadyPromise;
  }
  const baseUrl = options?.baseUrl ? ref(normalizeBaseUrl(options.baseUrl)) : sharedBaseUrl;

  // REST 统一携带 Bearer token（engine 除 /health 外全部要求鉴权）
  async function engineFetch(url: string, init?: RequestInit, timeoutMs?: number): Promise<Response> {
    // 首屏请求不得抢跑 token 异步拉取（真机 #12）：发出前先等解析链走完
    await ensureEngineTokenReady();
    const headers = new Headers(init?.headers);
    if (sharedToken.value) headers.set("Authorization", `Bearer ${sharedToken.value}`);
    const res = await fetchWithTimeout(url, { ...init, headers }, timeoutMs);
    // A6/F4：401（token 过期 / engine 重启后轮换）→ 作废就绪缓存 + 清 localStorage，
    // 下次调用重取——engine 后启动/轮换不再被旧 token 永锁
    if (res.status === 401) {
      invalidateEngineToken();
    }
    return res;
  }

  async function listAgents(): Promise<AgentConfig[]> {
    const res = await engineFetch(`${baseUrl.value}/agents`);
    await ensureOk(res, "list agents");
    return res.json();
  }

  async function createAgent(agent: AgentConfig): Promise<AgentConfig> {
    const res = await engineFetch(`${baseUrl.value}/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(agent),
    });
    await ensureOk(res, "create agent");
    return res.json();
  }

  async function getAgent(id: string): Promise<AgentConfig> {
    const res = await engineFetch(`${baseUrl.value}/agents/${encodeURIComponent(id)}`);
    await ensureOk(res, "get agent");
    return res.json();
  }

  async function updateAgent(id: string, agent: AgentConfig): Promise<AgentConfig> {
    const res = await engineFetch(`${baseUrl.value}/agents/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(agent),
    });
    await ensureOk(res, "update agent");
    return res.json();
  }

  async function deleteAgent(id: string): Promise<void> {
    const res = await engineFetch(`${baseUrl.value}/agents/${encodeURIComponent(id)}`, { method: "DELETE" });
    await ensureOk(res, "delete agent");
  }

  async function getMessages(
    agentId: string,
    sessionId: string,
    options: MessagePageOptions = {},
  ): Promise<ChatMessageRecord[]> {
    const params = new URLSearchParams();
    params.set("sessionId", sessionId);
    if (options.limit) params.set("limit", String(options.limit));
    if (options.before) params.set("before", options.before);
    const res = await engineFetch(`${baseUrl.value}/chat/${encodeURIComponent(agentId)}/messages?${params.toString()}`);
    await ensureOk(res, "get messages");
    return res.json();
  }

  // Sessions
  async function listSessions(): Promise<Session[]> {
    const res = await engineFetch(`${baseUrl.value}/sessions`);
    await ensureOk(res, "list sessions");
    return res.json();
  }

  async function createSession(session: Omit<Session, "id" | "createdAt" | "updatedAt">): Promise<Session> {
    const res = await engineFetch(`${baseUrl.value}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(session),
    });
    await ensureOk(res, "create session");
    return res.json();
  }

  // engine 只应用 name/agentIds（其余字段静默丢弃），类型与之一致
  async function updateSession(id: string, patch: Partial<Pick<Session, "name" | "agentIds">>): Promise<Session> {
    const res = await engineFetch(`${baseUrl.value}/sessions/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    await ensureOk(res, "update session");
    return res.json();
  }

  async function deleteSession(id: string): Promise<void> {
    const res = await engineFetch(`${baseUrl.value}/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
    await ensureOk(res, "delete session");
  }

  async function getSessionMessages(
    sessionId: string,
    options: MessagePageOptions = {},
  ): Promise<ChatMessageRecord[]> {
    const params = new URLSearchParams();
    if (options.limit) params.set("limit", String(options.limit));
    if (options.before) params.set("before", options.before);
    const res = await engineFetch(`${baseUrl.value}/sessions/${encodeURIComponent(sessionId)}/messages?${params.toString()}`);
    await ensureOk(res, "get session messages");
    return res.json();
  }

  // Plugins（外部插件加载结果只读端点）
  async function listPlugins(): Promise<PluginLoadResult> {
    const res = await engineFetch(`${baseUrl.value}/plugins`);
    await ensureOk(res, "list plugins");
    return res.json();
  }

  // Plugins manifest（M2 管理面：清单读写；400/404/409 由 ensureOk 透出 engine 的 error 正文）
  async function getPluginsManifest(): Promise<PluginsManifest> {
    const res = await engineFetch(`${baseUrl.value}/plugins/manifest`);
    await ensureOk(res, "get plugins manifest");
    return res.json();
  }

  async function updatePluginManifest(
    name: string,
    patch: PluginManifestPatch,
  ): Promise<PluginManifestUpdateResult> {
    const res = await engineFetch(`${baseUrl.value}/plugins/manifest/${encodeURIComponent(name)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    await ensureOk(res, "update plugin manifest");
    return res.json();
  }

  async function getAgentPluginsManifest(agentId: string): Promise<AgentPluginsManifest> {
    const res = await engineFetch(`${baseUrl.value}/agents/${encodeURIComponent(agentId)}/plugins/manifest`);
    await ensureOk(res, "get agent plugins manifest");
    return res.json();
  }

  async function updateAgentPluginManifest(
    agentId: string,
    name: string,
    patch: PluginManifestPatch,
  ): Promise<PluginManifestUpdateResult> {
    const res = await engineFetch(
      `${baseUrl.value}/agents/${encodeURIComponent(agentId)}/plugins/manifest/${encodeURIComponent(name)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      },
    );
    await ensureOk(res, "update agent plugin manifest");
    return res.json();
  }

  // blurb 管理 v3（tool-catalog 三清单 / 重生成 / 用户编辑）
  async function getToolCatalog(agentId: string): Promise<ToolCatalog> {
    const res = await engineFetch(`${baseUrl.value}/agents/${encodeURIComponent(agentId)}/tool-catalog`);
    await ensureOk(res, "get tool catalog");
    return res.json();
  }

  async function regenerateToolBlurbs(agentId: string, names?: string[]): Promise<ToolBlurbRegenerateResult> {
    const res = await engineFetch(
      `${baseUrl.value}/agents/${encodeURIComponent(agentId)}/tool-blurbs/regenerate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(names && names.length > 0 ? { names } : {}),
      },
      // 概括走 LLM 调用（最长 30s×3 重试），放宽到 120s 同 executeBlueprint 口径
      120_000,
    );
    await ensureOk(res, "regenerate tool blurbs");
    return res.json();
  }

  async function putToolBlurb(name: string, blurb: string): Promise<ToolBlurbEntry> {
    const res = await engineFetch(`${baseUrl.value}/tool-blurbs/${encodeURIComponent(name)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blurb }),
    });
    await ensureOk(res, "put tool blurb");
    return res.json();
  }

  // System（引擎版本/数据目录/运行时长等只读信息）
  async function getSystemInfo(): Promise<SystemInfo> {
    const res = await engineFetch(`${baseUrl.value}/system/info`);
    await ensureOk(res, "get system info");
    return res.json();
  }

  // Handoff（换班移交控制面：水位撞顶自动续跑）
  async function listHandoffs(
    agentId?: string,
    sessionId?: string,
  ): Promise<HandoffRecord[]> {
    const params = new URLSearchParams();
    if (agentId) params.set("agentId", agentId);
    if (sessionId) params.set("sessionId", sessionId);
    const qs = params.toString();
    const res = await engineFetch(`${baseUrl.value}/handoff${qs ? `?${qs}` : ""}`);
    await ensureOk(res, "list handoffs");
    return res.json();
  }

  // Compute
  async function listProviders(): Promise<Provider[]> {
    const res = await engineFetch(`${baseUrl.value}/compute/providers`);
    await ensureOk(res, "list providers");
    return res.json();
  }

  async function createProvider(body: Omit<Provider, "id">): Promise<Provider> {
    const res = await engineFetch(`${baseUrl.value}/compute/providers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await ensureOk(res, "create provider");
    return res.json();
  }

  // engine 应用 displayName/baseUrl/apiKey/apiMode/requestTimeout/maxRetries
  // （models/providerType 静默丢弃），类型与之一致
  async function updateProvider(
    id: string,
    body: Partial<
      Pick<Provider, "displayName" | "baseUrl" | "apiKey" | "apiMode" | "requestTimeout" | "maxRetries">
    >,
  ): Promise<Provider> {
    const res = await engineFetch(`${baseUrl.value}/compute/providers/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await ensureOk(res, "update provider");
    return res.json();
  }

  async function deleteProvider(id: string): Promise<void> {
    const res = await engineFetch(`${baseUrl.value}/compute/providers/${encodeURIComponent(id)}`, { method: "DELETE" });
    await ensureOk(res, "delete provider");
  }

  // engine 失败路径是 502（ensureOk 抛出），成功时才有 discovered
  async function testProvider(id: string): Promise<{ ok: true; discovered?: ModelInfo[] }> {
    // 探测外部 provider 的 models 列表，慢节点可能超过默认 10s，放宽到 30s
    const res = await engineFetch(`${baseUrl.value}/compute/providers/${encodeURIComponent(id)}/test`, { method: "POST" }, 30_000);
    await ensureOk(res, "test provider");
    return res.json();
  }

  async function addModel(providerId: string, body: ModelInfo): Promise<ModelInfo> {
    const res = await engineFetch(`${baseUrl.value}/compute/providers/${encodeURIComponent(providerId)}/models`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await ensureOk(res, "add model");
    return res.json();
  }

  async function deleteModel(providerId: string, modelId: string): Promise<void> {
    const res = await engineFetch(`${baseUrl.value}/compute/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(modelId)}`, { method: "DELETE" });
    await ensureOk(res, "delete model");
  }

  // Settings
  async function getConfig(): Promise<AppSettings & { providers: Provider[] }> {
    const res = await engineFetch(`${baseUrl.value}/config`);
    await ensureOk(res, "get config");
    return res.json();
  }

  async function updateConfig(body: Partial<AppSettings>): Promise<AppSettings> {
    const res = await engineFetch(`${baseUrl.value}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await ensureOk(res, "update config");
    return res.json();
  }

  async function getTools(): Promise<ToolInfo[]> {
    const res = await engineFetch(`${baseUrl.value}/config/tools`);
    await ensureOk(res, "get tools");
    return res.json();
  }

  // Logs
  async function getLogs(limit = 200): Promise<EngineLogEntry[]> {
    const res = await engineFetch(`${baseUrl.value}/logs?limit=${limit}`);
    await ensureOk(res, "get logs");
    return res.json();
  }

  // Scheduler
  async function getScheduledTasks(agentId: string): Promise<ScheduledTask[]> {
    const res = await engineFetch(`${baseUrl.value}/scheduler/${encodeURIComponent(agentId)}`);
    await ensureOk(res, "list scheduled tasks");
    return res.json();
  }

  async function createScheduledTask(
    agentId: string,
    // engine 创建时忽略 lastRunAt/nextRunAt 并自算 nextRunAt，类型上直接排除
    task: Omit<ScheduledTask, "id" | "agentId" | "createdAt" | "updatedAt" | "lastRunAt" | "nextRunAt">
  ): Promise<ScheduledTask> {
    const res = await engineFetch(`${baseUrl.value}/scheduler/${encodeURIComponent(agentId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(task),
    });
    await ensureOk(res, "create scheduled task");
    return res.json();
  }

  async function updateScheduledTask(
    agentId: string,
    taskId: string,
    patch: Partial<Omit<ScheduledTask, "id" | "agentId">>
  ): Promise<ScheduledTask> {
    const res = await engineFetch(`${baseUrl.value}/scheduler/${encodeURIComponent(agentId)}/${encodeURIComponent(taskId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    await ensureOk(res, "update scheduled task");
    return res.json();
  }

  async function deleteScheduledTask(agentId: string, taskId: string): Promise<void> {
    const res = await engineFetch(`${baseUrl.value}/scheduler/${encodeURIComponent(agentId)}/${encodeURIComponent(taskId)}`, { method: "DELETE" });
    await ensureOk(res, "delete scheduled task");
  }

  // WS 连接生命周期单点在 utils/managed-ws（D2 收敛：建连/重连/退避/4401 重建/
  // token 失效点只有一份）；这里只注入 token 三件套，connect/connectSession 是薄适配
  const wsDeps: ManagedWsDeps = {
    getToken: () => sharedToken.value,
    ensureTokenReady: ensureEngineTokenReady,
    invalidateToken: invalidateEngineToken,
  };

  function connect(agentId: string, sessionId: string, handlers: WebSocketHandlers): Connection {
    const wsUrl = baseUrl.value.replace(/^http/, "ws");
    return createManagedWsConnection(
      `${wsUrl}/ws/${encodeURIComponent(agentId)}?sessionId=${encodeURIComponent(sessionId)}`,
      handlers,
      false,
      wsDeps,
    );
  }

  // Blueprints
  async function listBlueprints(): Promise<Blueprint[]> {
    const res = await engineFetch(`${baseUrl.value}/blueprints`);
    await ensureOk(res, "list blueprints");
    return res.json();
  }

  async function createBlueprint(blueprint: Omit<Blueprint, "id" | "createdAt" | "updatedAt">): Promise<Blueprint> {
    const res = await engineFetch(`${baseUrl.value}/blueprints`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(blueprint),
    });
    await ensureOk(res, "create blueprint");
    return res.json();
  }

  async function getBlueprint(id: string): Promise<Blueprint> {
    const res = await engineFetch(`${baseUrl.value}/blueprints/${encodeURIComponent(id)}`);
    await ensureOk(res, "get blueprint");
    return res.json();
  }

  async function updateBlueprint(id: string, patch: Partial<Blueprint>): Promise<Blueprint> {
    const res = await engineFetch(`${baseUrl.value}/blueprints/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    await ensureOk(res, "update blueprint");
    return res.json();
  }

  async function deleteBlueprint(id: string): Promise<void> {
    const res = await engineFetch(`${baseUrl.value}/blueprints/${encodeURIComponent(id)}`, { method: "DELETE" });
    await ensureOk(res, "delete blueprint");
  }

  async function executeBlueprint(id: string, initialInput?: string): Promise<BlueprintExecution> {
    // engine 侧同步跑完整个 LLM 工作流才返回，远超默认 10s，放宽到 120s
    const res = await engineFetch(`${baseUrl.value}/blueprints/${encodeURIComponent(id)}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initialInput }),
    }, 120_000);
    await ensureOk(res, "execute blueprint");
    return res.json();
  }

  function connectSession(sessionId: string, handlers: WebSocketHandlers): Connection {
    const wsUrl = baseUrl.value.replace(/^http/, "ws");
    return createManagedWsConnection(
      `${wsUrl}/ws/sessions/${encodeURIComponent(sessionId)}`,
      handlers,
      true,
      wsDeps,
    );
  }

  return {
    listAgents,
    createAgent,
    getAgent,
    updateAgent,
    deleteAgent,
    getMessages,
    listSessions,
    createSession,
    updateSession,
    deleteSession,
    getSessionMessages,
    listPlugins,
    getPluginsManifest,
    updatePluginManifest,
    getAgentPluginsManifest,
    updateAgentPluginManifest,
    getToolCatalog,
    regenerateToolBlurbs,
    putToolBlurb,
    getSystemInfo,
    listHandoffs,
    listProviders,
    createProvider,
    updateProvider,
    deleteProvider,
    testProvider,
    addModel,
    deleteModel,
    getConfig,
    updateConfig,
    getTools,
    getLogs,
    getScheduledTasks,
    createScheduledTask,
    updateScheduledTask,
    deleteScheduledTask,
    connect,
    connectSession,
    listBlueprints,
    createBlueprint,
    getBlueprint,
    updateBlueprint,
    deleteBlueprint,
    executeBlueprint,
  };
}
