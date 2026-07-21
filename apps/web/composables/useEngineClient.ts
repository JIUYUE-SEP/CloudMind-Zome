import type { AgentConfig, ChatMode } from "@mindcloud/shared";
import { ref } from "vue";
import { fetchWithTimeout } from "@/utils/fetch";

export interface ChatMessageRecord {
  id: string;
  role: "user" | "assistant" | "tool";
  content: Array<{ type: "text"; text: string } | { type: "think"; think: string }>;
  toolCalls?: { toolCallId: string; name: string; arguments: unknown }[];
  toolCallId?: string;
  // 群聊历史：assistant/tool 消息归属的 Agent（engine 合并各成员仓库时标注）；user 消息不带
  agentId?: string;
  createdAt: string;
}

export interface ModelInfo {
  id: string;
  displayName: string;
  modelType: "llm" | "embedding" | "image" | "stt";
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsReasoning?: boolean;
  supportsToolCalling?: boolean;
  supportsMultimodal?: boolean;
}

export interface Provider {
  id: string;
  displayName: string;
  providerType: "openai";
  baseUrl: string;
  apiKey?: string;
  hasApiKey?: boolean;
  models: ModelInfo[];
}

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

interface ScheduledTask {
  id: string;
  agentId: string;
  description: string;
  prompt: string;
  cron: string;
  enabled: boolean;
  lastRunAt?: string;
  nextRunAt?: string;
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
  onApprovalRequest?: (request: {
    approvalId: string;
    toolCallId: string;
    toolName: string;
    arguments: unknown;
    agentId?: string;
  }) => void;
  onStepEnd?: (finishReason?: string, agentId?: string) => void;
  // 一轮生成结束（与 step.end 区分：后者每个 ReAct step 都发）；
  // 输入框锁定等"生成中"状态只应在 turn.end / error / close 时复位
  onTurnEnd?: (agentId?: string) => void;
  onError?: (error: string) => void;
  onClose?: () => void;
  onModeChanged?: (mode: ChatMode, projectId?: string) => void;
}

export interface Connection {
  send(text: string): boolean;
  sendRaw(message: object): boolean;
  setMode(mode: ChatMode, projectId?: string): boolean;
  close(): void;
}

const DEFAULT_ENGINE_URL = "http://127.0.0.1:8848";

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
const sharedBaseUrl = ref(DEFAULT_ENGINE_URL);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tauriGlobal = typeof window !== "undefined" ? ((window as any).__TAURI__ ?? undefined) : undefined;

// Tauri 环境：模块加载时经 __TAURI__.core.invoke 拿 sidecar 端口（需 tauri.conf withGlobalTauri），
// resolve 后更新缓存；失败保留默认 8848
if (tauriGlobal?.core?.invoke) {
  tauriGlobal.core
    .invoke("get_backend_url")
    .then((url: unknown) => {
      if (typeof url === "string" && url) sharedBaseUrl.value = url;
    })
    .catch(() => {
      // backend 未就绪或 IPC 失败：保留默认 8848
    });
}

// 非 Tauri 环境：首次调用时从 runtimeConfig 取一次（NUXT_PUBLIC_ENGINE_URL 可覆盖），之后缓存复用
let runtimeConfigApplied = false;

export function useEngineClient(options?: EngineClientOptions) {
  const config = useRuntimeConfig();
  if (!runtimeConfigApplied && !tauriGlobal) {
    runtimeConfigApplied = true;
    if (config.public.engineUrl) sharedBaseUrl.value = config.public.engineUrl as string;
  }
  const baseUrl = options?.baseUrl ? ref(options.baseUrl) : sharedBaseUrl;

  async function listAgents(): Promise<AgentConfig[]> {
    const res = await fetchWithTimeout(`${baseUrl.value}/agents`);
    await ensureOk(res, "list agents");
    return res.json();
  }

  async function createAgent(agent: AgentConfig): Promise<AgentConfig> {
    const res = await fetchWithTimeout(`${baseUrl.value}/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(agent),
    });
    await ensureOk(res, "create agent");
    return res.json();
  }

  async function getAgent(id: string): Promise<AgentConfig> {
    const res = await fetchWithTimeout(`${baseUrl.value}/agents/${encodeURIComponent(id)}`);
    await ensureOk(res, "get agent");
    return res.json();
  }

  async function updateAgent(id: string, agent: AgentConfig): Promise<AgentConfig> {
    const res = await fetchWithTimeout(`${baseUrl.value}/agents/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(agent),
    });
    await ensureOk(res, "update agent");
    return res.json();
  }

  async function deleteAgent(id: string): Promise<void> {
    const res = await fetchWithTimeout(`${baseUrl.value}/agents/${encodeURIComponent(id)}`, { method: "DELETE" });
    await ensureOk(res, "delete agent");
  }

  async function getMessages(agentId: string, sessionId: string, limit?: number): Promise<ChatMessageRecord[]> {
    const params = new URLSearchParams();
    params.set("sessionId", sessionId);
    if (limit) params.set("limit", String(limit));
    const res = await fetchWithTimeout(`${baseUrl.value}/chat/${encodeURIComponent(agentId)}/messages?${params.toString()}`);
    await ensureOk(res, "get messages");
    return res.json();
  }

  // Sessions
  async function listSessions(): Promise<Session[]> {
    const res = await fetchWithTimeout(`${baseUrl.value}/sessions`);
    await ensureOk(res, "list sessions");
    return res.json();
  }

  async function createSession(session: Omit<Session, "id" | "createdAt" | "updatedAt">): Promise<Session> {
    const res = await fetchWithTimeout(`${baseUrl.value}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(session),
    });
    await ensureOk(res, "create session");
    return res.json();
  }

  async function updateSession(id: string, patch: Partial<Session>): Promise<Session> {
    const res = await fetchWithTimeout(`${baseUrl.value}/sessions/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    await ensureOk(res, "update session");
    return res.json();
  }

  async function deleteSession(id: string): Promise<void> {
    const res = await fetchWithTimeout(`${baseUrl.value}/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
    await ensureOk(res, "delete session");
  }

  async function getSessionMessages(sessionId: string, limit?: number): Promise<ChatMessageRecord[]> {
    const params = new URLSearchParams();
    if (limit) params.set("limit", String(limit));
    const res = await fetchWithTimeout(`${baseUrl.value}/sessions/${encodeURIComponent(sessionId)}/messages?${params.toString()}`);
    await ensureOk(res, "get session messages");
    return res.json();
  }

  // Compute
  async function listProviders(): Promise<Provider[]> {
    const res = await fetchWithTimeout(`${baseUrl.value}/compute/providers`);
    await ensureOk(res, "list providers");
    return res.json();
  }

  async function createProvider(body: Omit<Provider, "id">): Promise<Provider> {
    const res = await fetchWithTimeout(`${baseUrl.value}/compute/providers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await ensureOk(res, "create provider");
    return res.json();
  }

  async function updateProvider(id: string, body: Partial<Provider>): Promise<Provider> {
    const res = await fetchWithTimeout(`${baseUrl.value}/compute/providers/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await ensureOk(res, "update provider");
    return res.json();
  }

  async function deleteProvider(id: string): Promise<void> {
    const res = await fetchWithTimeout(`${baseUrl.value}/compute/providers/${encodeURIComponent(id)}`, { method: "DELETE" });
    await ensureOk(res, "delete provider");
  }

  async function testProvider(id: string): Promise<{ ok: boolean; discovered?: ModelInfo[]; error?: string }> {
    // 探测外部 provider 的 models 列表，慢节点可能超过默认 10s，放宽到 30s
    const res = await fetchWithTimeout(`${baseUrl.value}/compute/providers/${encodeURIComponent(id)}/test`, { method: "POST" }, 30_000);
    await ensureOk(res, "test provider");
    return res.json();
  }

  async function addModel(providerId: string, body: ModelInfo): Promise<ModelInfo> {
    const res = await fetchWithTimeout(`${baseUrl.value}/compute/providers/${encodeURIComponent(providerId)}/models`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await ensureOk(res, "add model");
    return res.json();
  }

  async function updateModel(providerId: string, modelId: string, body: Partial<ModelInfo>): Promise<ModelInfo> {
    const res = await fetchWithTimeout(`${baseUrl.value}/compute/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(modelId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await ensureOk(res, "update model");
    return res.json();
  }

  async function deleteModel(providerId: string, modelId: string): Promise<void> {
    const res = await fetchWithTimeout(`${baseUrl.value}/compute/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(modelId)}`, { method: "DELETE" });
    await ensureOk(res, "delete model");
  }

  // Settings
  async function getConfig(): Promise<AppSettings & { providers: Provider[] }> {
    const res = await fetchWithTimeout(`${baseUrl.value}/config`);
    await ensureOk(res, "get config");
    return res.json();
  }

  async function updateConfig(body: Partial<AppSettings>): Promise<AppSettings> {
    const res = await fetchWithTimeout(`${baseUrl.value}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await ensureOk(res, "update config");
    return res.json();
  }

  async function getTools(): Promise<ToolInfo[]> {
    const res = await fetchWithTimeout(`${baseUrl.value}/config/tools`);
    await ensureOk(res, "get tools");
    return res.json();
  }

  // Logs
  async function getLogs(limit = 200): Promise<EngineLogEntry[]> {
    const res = await fetchWithTimeout(`${baseUrl.value}/logs?limit=${limit}`);
    await ensureOk(res, "get logs");
    return res.json();
  }

  // Scheduler
  async function getScheduledTasks(agentId: string): Promise<ScheduledTask[]> {
    const res = await fetchWithTimeout(`${baseUrl.value}/scheduler/${encodeURIComponent(agentId)}`);
    await ensureOk(res, "list scheduled tasks");
    return res.json();
  }

  async function createScheduledTask(
    agentId: string,
    task: Omit<ScheduledTask, "id" | "agentId">
  ): Promise<ScheduledTask> {
    const res = await fetchWithTimeout(`${baseUrl.value}/scheduler/${encodeURIComponent(agentId)}`, {
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
    const res = await fetchWithTimeout(`${baseUrl.value}/scheduler/${encodeURIComponent(agentId)}/${encodeURIComponent(taskId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    await ensureOk(res, "update scheduled task");
    return res.json();
  }

  async function deleteScheduledTask(agentId: string, taskId: string): Promise<void> {
    const res = await fetchWithTimeout(`${baseUrl.value}/scheduler/${encodeURIComponent(agentId)}/${encodeURIComponent(taskId)}`, { method: "DELETE" });
    await ensureOk(res, "delete scheduled task");
  }

  function connect(agentId: string, sessionId: string, handlers: WebSocketHandlers): Connection {
    const wsUrl = baseUrl.value.replace(/^http/, "ws");
    const socket = new WebSocket(`${wsUrl}/ws/${encodeURIComponent(agentId)}?sessionId=${encodeURIComponent(sessionId)}`);

    socket.onopen = () => {
      handlers.onOpen?.();
    };

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        switch (data.type) {
          case "text.delta":
            handlers.onTextDelta?.(data.delta);
            break;
          case "thinking.delta":
            handlers.onThinkingDelta?.(data.delta);
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
            handlers.onStepEnd?.(data.finishReason);
            break;
          case "turn.end":
            handlers.onTurnEnd?.();
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

    socket.onerror = () => handlers.onError?.("WebSocket error");
    socket.onclose = () => handlers.onClose?.();

    return {
      send(text: string) {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ text }));
          return true;
        }
        return false;
      },
      sendRaw(message: object) {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify(message));
          return true;
        }
        return false;
      },
      setMode(mode: ChatMode, projectId?: string) {
        return this.sendRaw({ type: "session.set_mode", mode, projectId });
      },
      close() {
        socket.close();
      },
    };
  }

  // Blueprints
  async function listBlueprints(): Promise<Blueprint[]> {
    const res = await fetchWithTimeout(`${baseUrl.value}/blueprints`);
    await ensureOk(res, "list blueprints");
    return res.json();
  }

  async function createBlueprint(blueprint: Omit<Blueprint, "id" | "createdAt" | "updatedAt">): Promise<Blueprint> {
    const res = await fetchWithTimeout(`${baseUrl.value}/blueprints`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(blueprint),
    });
    await ensureOk(res, "create blueprint");
    return res.json();
  }

  async function getBlueprint(id: string): Promise<Blueprint> {
    const res = await fetchWithTimeout(`${baseUrl.value}/blueprints/${encodeURIComponent(id)}`);
    await ensureOk(res, "get blueprint");
    return res.json();
  }

  async function updateBlueprint(id: string, patch: Partial<Blueprint>): Promise<Blueprint> {
    const res = await fetchWithTimeout(`${baseUrl.value}/blueprints/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    await ensureOk(res, "update blueprint");
    return res.json();
  }

  async function deleteBlueprint(id: string): Promise<void> {
    const res = await fetchWithTimeout(`${baseUrl.value}/blueprints/${encodeURIComponent(id)}`, { method: "DELETE" });
    await ensureOk(res, "delete blueprint");
  }

  async function executeBlueprint(id: string, initialInput?: string): Promise<BlueprintExecution> {
    // engine 侧同步跑完整个 LLM 工作流才返回，远超默认 10s，放宽到 120s
    const res = await fetchWithTimeout(`${baseUrl.value}/blueprints/${encodeURIComponent(id)}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initialInput }),
    }, 120_000);
    await ensureOk(res, "execute blueprint");
    return res.json();
  }

  function connectSession(sessionId: string, handlers: WebSocketHandlers): Connection {
    const wsUrl = baseUrl.value.replace(/^http/, "ws");
    const socket = new WebSocket(`${wsUrl}/ws/sessions/${encodeURIComponent(sessionId)}`);

    socket.onopen = () => {
      handlers.onOpen?.();
    };

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        switch (data.type) {
          case "text.delta":
            handlers.onTextDelta?.(data.delta, data.agentId);
            break;
          case "thinking.delta":
            handlers.onThinkingDelta?.(data.delta, data.agentId);
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
            handlers.onStepEnd?.(data.finishReason, data.agentId);
            break;
          case "turn.end":
            handlers.onTurnEnd?.(data.agentId);
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

    socket.onerror = () => handlers.onError?.("WebSocket error");
    socket.onclose = () => handlers.onClose?.();

    return {
      send(text: string) {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ text }));
          return true;
        }
        return false;
      },
      sendRaw(message: object) {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify(message));
          return true;
        }
        return false;
      },
      setMode(mode: ChatMode, projectId?: string) {
        return this.sendRaw({ type: "session.set_mode", mode, projectId });
      },
      close() {
        socket.close();
      },
    };
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
    listBlueprints,
    createBlueprint,
    getBlueprint,
    updateBlueprint,
    deleteBlueprint,
    executeBlueprint,
  };
}
