import type { AgentConfig, ChatMode } from "@mindcloud/shared";
import type { ChatMessageRecord, ModelInfo, ProviderConfig, ScheduledTask } from "@mindcloud/shared";
import { DEFAULT_ENGINE_URL } from "@mindcloud/shared";
import type { ApprovalRequestPayload } from "@/utils/approval";
import { ref } from "vue";
import { fetchWithTimeout } from "@/utils/fetch";
import { resolveEngineToken, fetchEngineTokenFromServer } from "@/utils/engine-token";

// REST DTO 权威定义在 packages/shared（P5-2 收敛），此处再导出保持既有引用不变
// （ScheduledTask 由 stores/scheduler.ts 再导出，避免 Nuxt 自动导入重名告警）
export type { ChatMessageRecord, ModelInfo };
export type Provider = ProviderConfig;

export interface MemorySettings {
  compactThreshold: number;
  keepRecent: number;
  hotMemoryLimit: number;
  warmMemoryLimit: number;
}

export interface AppSettings {
  tavilyApiKey?: string;
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

export interface Session {
  id: string;
  name: string;
  agentIds: string[];
  type: "group" | "intermind";
  mode?: ChatMode;
  projectId?: string;
  createdAt: string;
  updatedAt: string;
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

export interface WebSocketHandlers {
  onOpen?: () => void;
  // 群聊帧会额外携带 agentId（多 Agent 并发流式靠它分槽）；私聊帧为 undefined
  onTextDelta?: (delta: string, agentId?: string) => void;
  onThinkingDelta?: (delta: string, agentId?: string) => void;
  onToolCall?: (toolCall: { toolCallId: string; name: string; arguments: unknown }) => void;
  onToolResult?: (result: { toolCallId: string; output: unknown }) => void;
  // 危险工具审批请求（群聊帧会额外携带 agentId）
  onApprovalRequest?: (request: ApprovalRequestPayload) => void;
  onStepEnd?: (finishReason?: string, agentId?: string) => void;
  // 一轮生成结束（与 step.end 区分：后者每个 ReAct step 都发）；
  // 输入框锁定等"生成中"状态只应在 turn.end / error / close 时复位
  onTurnEnd?: (agentId?: string) => void;
  onError?: (error: string) => void;
  onClose?: (code?: number, reason?: string) => void;
  // 异常断开后的自动重连（P0-3）：第 attempt 次重试将在 delayMs 后发起
  onReconnecting?: (attempt: number, delayMs: number) => void;
  // 重连成功（仅断线后的再次 onOpen 触发，首次连接不触发）；调用方应在此拉取状态对齐
  onReconnected?: () => void;
  onModeChanged?: (mode: ChatMode, projectId?: string) => void;
}

export interface Connection {
  send(text: string): boolean;
  sendRaw(message: object): boolean;
  setMode(mode: ChatMode, projectId?: string): boolean;
  close(): void;
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
// 默认地址的权威定义在 packages/shared（P5-2）；Tauri 环境经 IPC 取 sidecar 实际端口覆盖
const sharedBaseUrl = ref(DEFAULT_ENGINE_URL);

// 模块级鉴权 token 单例（与 sharedBaseUrl 同一模式）。engine 本地 token 鉴权（P0-2）：
// 除 /health 外 REST 全部要求 Bearer，WS 握手要求子协议携带 token。
// 分发通道：desktop 由 Rust 侧读数据目录 auth-token 文件经 IPC 下发；
// web 开发默认由 nitro dev server 读 engine 数据目录 auth-token 文件经
// /api/engine-token 运行时下发（零配置）；NUXT_PUBLIC_ENGINE_TOKEN /
// localStorage["cloudmind.engineToken"] 仍是优先级更高的显式覆盖。
const sharedToken = ref("");

// token 就绪 Promise 单例（与 sharedToken 配套）：模块首次解析 token 时创建，
// engineFetch / WS 建连前 await 它，避免首屏请求抢跑 /api/engine-token 异步拉取
// （真机 #12）。就绪只等一次：后续请求直接复用已解析的 Promise，不重复拉 server。
let engineTokenReadyPromise: Promise<string> | null = null;

// desktop sidecar 意外退出（kill_on_drop 会连带杀掉 engine，WS 随之断开）：
// Tauri 侧 emit 事件到这里置位，UI 据此提示"engine 进程已退出"，
// 而不是永远停在"重连中"（P0-3 D-B1）
const sidecarTerminated = ref(false);

// baseUrl 尾部斜杠未归一会拼出 "//agents" 导致全部 404：赋值入口统一去除
function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tauriGlobal = typeof window !== "undefined" ? ((window as any).__TAURI__ ?? undefined) : undefined;

// Tauri 环境：模块加载时经 __TAURI__.core.invoke 拿 sidecar 端口（需 tauri.conf withGlobalTauri），
// resolve 后更新缓存；失败保留默认 8848
if (tauriGlobal?.core?.invoke) {
  tauriGlobal.core
    .invoke("get_backend_url")
    .then((url: unknown) => {
      if (typeof url === "string" && url) sharedBaseUrl.value = normalizeBaseUrl(url);
    })
    .catch(() => {
      // backend 未就绪或 IPC 失败：保留默认 8848
    });
}

// Tauri：token 经 IPC 异步下发（模块加载即开始），同样纳入就绪 Promise——
// 首屏 REST/WS 请求必须等 IPC 解析链走完，而不是带着空 token 抢跑
const tauriTokenReady: Promise<string> = tauriGlobal?.core?.invoke
  ? tauriGlobal.core
      .invoke("get_engine_token")
      .then((token: unknown) => {
        const resolved = typeof token === "string" ? token : "";
        if (resolved) sharedToken.value = resolved;
        return resolved;
      })
      .catch(() => {
        // token 未就绪：REST/WS 会被 401/4401 拒绝，界面走既有错误路径提示
        return "";
      })
  : Promise.resolve("");

// sidecar 意外退出事件（desktop）：engine 被连带杀掉，UI 需要明确提示而非静默重连
if (tauriGlobal?.event?.listen) {
  tauriGlobal.event
    .listen("zome://sidecar-terminated", () => {
      sidecarTerminated.value = true;
    })
    .catch(() => {});
}

// 非 Tauri 环境：首次调用时从 runtimeConfig 取一次（NUXT_PUBLIC_ENGINE_URL 可覆盖），之后缓存复用
let runtimeConfigApplied = false;

export function useEngineClient(options?: EngineClientOptions) {
  const config = useRuntimeConfig();

  // web 端 token 解析链（非 Tauri）：应用 runtime 显式档/localStorage 档，
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
      engineTokenReadyPromise = tauriGlobal ? tauriTokenReady : resolveWebToken();
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
    return fetchWithTimeout(url, { ...init, headers }, timeoutMs);
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

  async function getMessages(agentId: string, sessionId: string, limit?: number): Promise<ChatMessageRecord[]> {
    const params = new URLSearchParams();
    params.set("sessionId", sessionId);
    if (limit) params.set("limit", String(limit));
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

  async function getSessionMessages(sessionId: string, limit?: number): Promise<ChatMessageRecord[]> {
    const params = new URLSearchParams();
    if (limit) params.set("limit", String(limit));
    const res = await engineFetch(`${baseUrl.value}/sessions/${encodeURIComponent(sessionId)}/messages?${params.toString()}`);
    await ensureOk(res, "get session messages");
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

  async function updateModel(providerId: string, modelId: string, body: Partial<ModelInfo>): Promise<ModelInfo> {
    const res = await engineFetch(`${baseUrl.value}/compute/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(modelId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await ensureOk(res, "update model");
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

  // engine 主动关闭的业务码：终态（agent/session 不存在、参数非法、鉴权失败、Origin 拒绝），
  // 重连无意义，直接透传 onClose；其余（1006 异常断开等）一律自动重连
  const TERMINAL_WS_CLOSE_CODES = new Set([4001, 4002, 4003, 4004, 4401, 4403]);

  // WS 断线自动重连（P0-3 D-B2）：指数退避 1s/2s/4s…封顶 30s，永不放弃——
  // supervisor 侧同样永不放弃重启 engine，两端合成恢复闭环
  const RECONNECT_BASE_DELAY_MS = 1_000;
  const RECONNECT_MAX_DELAY_MS = 30_000;

  function createManagedConnection(
    url: string,
    handlers: WebSocketHandlers,
    isSession: boolean,
  ): Connection {
    let socket: WebSocket | null = null;
    let closedByCaller = false;
    let hasConnectedOnce = false;
    let reconnectAttempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    const clearReconnectTimer = () => {
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
    };

    const open = () => {
      clearReconnectTimer();
      // 浏览器 WS 不能设请求头：token 经 Sec-WebSocket-Protocol 子协议传递（不出现在 URL/日志）
      socket = sharedToken.value ? new WebSocket(url, sharedToken.value) : new WebSocket(url);

      socket.onopen = () => {
        const isReconnect = hasConnectedOnce;
        hasConnectedOnce = true;
        reconnectAttempts = 0;
        handlers.onOpen?.();
        // 断线后的重连成功：调用方拉取会话状态对齐（最新消息列表）
        if (isReconnect) handlers.onReconnected?.();
      };

      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          switch (data.type) {
            // 群聊帧透出 agentId；私聊保持单参数调用形态（调用方按 arity 区分）
            case "text.delta":
              if (isSession) handlers.onTextDelta?.(data.delta, data.agentId);
              else handlers.onTextDelta?.(data.delta);
              break;
            case "thinking.delta":
              if (isSession) handlers.onThinkingDelta?.(data.delta, data.agentId);
              else handlers.onThinkingDelta?.(data.delta);
              break;
            case "tool.call":
              handlers.onToolCall?.(data);
              break;
            case "tool.result":
              handlers.onToolResult?.(data);
              break;
            case "tool.approval_request":
              handlers.onApprovalRequest?.(data);
              break;
            case "step.end":
              if (isSession) handlers.onStepEnd?.(data.finishReason, data.agentId);
              else handlers.onStepEnd?.(data.finishReason);
              break;
            case "turn.end":
              if (isSession) handlers.onTurnEnd?.(data.agentId);
              else handlers.onTurnEnd?.();
              break;
            case "session.mode_changed":
              handlers.onModeChanged?.(data.mode, data.projectId);
              break;
            case "error":
              handlers.onError?.(data.error);
              break;
          }
        } catch {
          handlers.onError?.("Invalid message from server");
        }
      };

      // 连接被拒时浏览器先 fire error 再 fire close(1006)：每次失败的重连尝试
      // 都会命中这里，透传会无限刷错误气泡（P0 review 返工）。只在首连第一次
      // 失败透传（一次性提示）；重连进行态由 onReconnecting 统一呈现
      socket.onerror = () => {
        // 只在首次连接的第一次失败透传（onerror 先于 onclose，此时
        // reconnectAttempts 仍为 0）；后续失败尝试由 onReconnecting 呈现
        if (!hasConnectedOnce && reconnectAttempts === 0) {
          handlers.onError?.("WebSocket error");
        }
      };

      socket.onclose = (event) => {
        const code = event?.code;
        // 调用方主动关闭 / 终态业务码：透传，不重连
        if (closedByCaller || (code !== undefined && TERMINAL_WS_CLOSE_CODES.has(code))) {
          handlers.onClose?.(code, event?.reason);
          return;
        }
        reconnectAttempts += 1;
        const delay = Math.min(
          RECONNECT_BASE_DELAY_MS * 2 ** (reconnectAttempts - 1),
          RECONNECT_MAX_DELAY_MS,
        );
        handlers.onReconnecting?.(reconnectAttempts, delay);
        reconnectTimer = setTimeout(open, delay);
      };
    };

    // 建连前必须等 token 就绪（真机 #12）：REST 与 WS 都不能带着空 token 抢跑
    // /api/engine-token / Tauri IPC 的异步解析；就绪 Promise 模块级缓存，只等一次。
    // 重连仍直接 open()——首次建连成功时 token 必然已就绪
    void ensureEngineTokenReady().then(() => {
      if (!closedByCaller) open();
    });

    const sendRawFrame = (message: object): boolean => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message));
        return true;
      }
      return false;
    };

    return {
      send(text: string) {
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ text }));
          return true;
        }
        return false;
      },
      sendRaw: sendRawFrame,
      // 经闭包而非 this.sendRaw 调用：解构 setMode 后 this 会丢失
      setMode: (mode: ChatMode, projectId?: string) =>
        sendRawFrame({ type: "session.set_mode", mode, projectId }),
      close() {
        closedByCaller = true;
        clearReconnectTimer();
        socket?.close();
      },
    };
  }

  function connect(agentId: string, sessionId: string, handlers: WebSocketHandlers): Connection {
    const wsUrl = baseUrl.value.replace(/^http/, "ws");
    return createManagedConnection(
      `${wsUrl}/ws/${encodeURIComponent(agentId)}?sessionId=${encodeURIComponent(sessionId)}`,
      handlers,
      false,
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
    return createManagedConnection(
      `${wsUrl}/ws/sessions/${encodeURIComponent(sessionId)}`,
      handlers,
      true,
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
    listProviders,
    createProvider,
    updateProvider,
    deleteProvider,
    testProvider,
    addModel,
    updateModel,
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
    // desktop sidecar 意外退出置位（P0-3）：UI 据此提示"engine 进程已退出"
    sidecarTerminated,
    listBlueprints,
    createBlueprint,
    getBlueprint,
    updateBlueprint,
    deleteBlueprint,
    executeBlueprint,
  };
}
