import type { AgentConfig } from "@mindcloud/shared";
import { invoke } from "@tauri-apps/api/core";
import { ref, onMounted } from "vue";

export interface ChatMessageRecord {
  id: string;
  role: "user" | "assistant" | "tool";
  content: Array<{ type: "text"; text: string } | { type: "think"; think: string }>;
  toolCalls?: { toolCallId: string; name: string; arguments: unknown }[];
  toolCallId?: string;
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
  onTextDelta?: (delta: string) => void;
  onThinkingDelta?: (delta: string) => void;
  onToolCall?: (toolCall: { toolCallId: string; name: string; arguments: unknown }) => void;
  onToolResult?: (result: { toolCallId: string; output: unknown }) => void;
  onStepEnd?: (finishReason?: string) => void;
  onError?: (error: string) => void;
  onClose?: () => void;
}

export interface Connection {
  send(text: string): void;
  close(): void;
}

export function useEngineClient(options?: EngineClientOptions) {
  const config = useRuntimeConfig();
  const baseUrl = ref<string>(
    options?.baseUrl || (config.public.engineUrl as string) || "http://127.0.0.1:8848"
  );

  onMounted(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (typeof window !== "undefined" && (window as any).__TAURI__) {
      try {
        baseUrl.value = await invoke<string>("get_backend_url");
      } catch {
        // fallback to default
      }
    }
  });

  async function listAgents(): Promise<AgentConfig[]> {
    const res = await fetch(`${baseUrl.value}/agents`);
    if (!res.ok) throw new Error(`Failed to list agents: ${res.status}`);
    return res.json();
  }

  async function createAgent(agent: AgentConfig): Promise<AgentConfig> {
    const res = await fetch(`${baseUrl.value}/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(agent),
    });
    if (!res.ok) throw new Error(`Failed to create agent: ${res.status}`);
    return res.json();
  }

  async function getAgent(id: string): Promise<AgentConfig> {
    const res = await fetch(`${baseUrl.value}/agents/${id}`);
    if (!res.ok) throw new Error(`Failed to get agent: ${res.status}`);
    return res.json();
  }

  async function updateAgent(id: string, agent: AgentConfig): Promise<AgentConfig> {
    const res = await fetch(`${baseUrl.value}/agents/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(agent),
    });
    if (!res.ok) throw new Error(`Failed to update agent: ${res.status}`);
    return res.json();
  }

  async function deleteAgent(id: string): Promise<void> {
    const res = await fetch(`${baseUrl.value}/agents/${id}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`Failed to delete agent: ${res.status}`);
  }

  async function getMessages(agentId: string, sessionId: string, limit?: number): Promise<ChatMessageRecord[]> {
    const params = new URLSearchParams();
    params.set("sessionId", sessionId);
    if (limit) params.set("limit", String(limit));
    const res = await fetch(`${baseUrl.value}/chat/${agentId}/messages?${params.toString()}`);
    if (!res.ok) throw new Error(`Failed to get messages: ${res.status}`);
    return res.json();
  }

  // Sessions
  async function listSessions(): Promise<Session[]> {
    const res = await fetch(`${baseUrl.value}/sessions`);
    if (!res.ok) throw new Error(`Failed to list sessions: ${res.status}`);
    return res.json();
  }

  async function createSession(session: Omit<Session, "id" | "createdAt" | "updatedAt">): Promise<Session> {
    const res = await fetch(`${baseUrl.value}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(session),
    });
    if (!res.ok) throw new Error(`Failed to create session: ${res.status}`);
    return res.json();
  }

  async function updateSession(id: string, patch: Partial<Session>): Promise<Session> {
    const res = await fetch(`${baseUrl.value}/sessions/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(`Failed to update session: ${res.status}`);
    return res.json();
  }

  async function deleteSession(id: string): Promise<void> {
    const res = await fetch(`${baseUrl.value}/sessions/${id}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`Failed to delete session: ${res.status}`);
  }

  async function getSessionMessages(sessionId: string, limit?: number): Promise<ChatMessageRecord[]> {
    const params = new URLSearchParams();
    if (limit) params.set("limit", String(limit));
    const res = await fetch(`${baseUrl.value}/sessions/${sessionId}/messages?${params.toString()}`);
    if (!res.ok) throw new Error(`Failed to get session messages: ${res.status}`);
    return res.json();
  }

  // Compute
  async function listProviders(): Promise<Provider[]> {
    const res = await fetch(`${baseUrl.value}/compute/providers`);
    if (!res.ok) throw new Error(`Failed to list providers: ${res.status}`);
    return res.json();
  }

  async function createProvider(body: Omit<Provider, "id">): Promise<Provider> {
    const res = await fetch(`${baseUrl.value}/compute/providers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Failed to create provider: ${res.status}`);
    return res.json();
  }

  async function updateProvider(id: string, body: Partial<Provider>): Promise<Provider> {
    const res = await fetch(`${baseUrl.value}/compute/providers/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Failed to update provider: ${res.status}`);
    return res.json();
  }

  async function deleteProvider(id: string): Promise<void> {
    const res = await fetch(`${baseUrl.value}/compute/providers/${id}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`Failed to delete provider: ${res.status}`);
  }

  async function testProvider(id: string): Promise<{ ok: boolean; discovered?: ModelInfo[]; error?: string }> {
    const res = await fetch(`${baseUrl.value}/compute/providers/${id}/test`, { method: "POST" });
    return res.json();
  }

  async function addModel(providerId: string, body: ModelInfo): Promise<ModelInfo> {
    const res = await fetch(`${baseUrl.value}/compute/providers/${providerId}/models`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Failed to add model: ${res.status}`);
    return res.json();
  }

  async function updateModel(providerId: string, modelId: string, body: Partial<ModelInfo>): Promise<ModelInfo> {
    const res = await fetch(`${baseUrl.value}/compute/providers/${providerId}/models/${modelId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Failed to update model: ${res.status}`);
    return res.json();
  }

  async function deleteModel(providerId: string, modelId: string): Promise<void> {
    const res = await fetch(`${baseUrl.value}/compute/providers/${providerId}/models/${modelId}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`Failed to delete model: ${res.status}`);
  }

  // Settings
  async function getConfig(): Promise<AppSettings & { providers: Provider[] }> {
    const res = await fetch(`${baseUrl.value}/config`);
    if (!res.ok) throw new Error(`Failed to get config: ${res.status}`);
    return res.json();
  }

  async function updateConfig(body: Partial<AppSettings>): Promise<AppSettings> {
    const res = await fetch(`${baseUrl.value}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Failed to update config: ${res.status}`);
    return res.json();
  }

  async function getTools(): Promise<ToolInfo[]> {
    const res = await fetch(`${baseUrl.value}/config/tools`);
    if (!res.ok) throw new Error(`Failed to get tools: ${res.status}`);
    return res.json();
  }

  // Scheduler
  async function getScheduledTasks(agentId: string): Promise<ScheduledTask[]> {
    const res = await fetch(`${baseUrl.value}/scheduler/${agentId}`);
    if (!res.ok) throw new Error(`Failed to list scheduled tasks: ${res.status}`);
    return res.json();
  }

  async function createScheduledTask(
    agentId: string,
    task: Omit<ScheduledTask, "id" | "agentId">
  ): Promise<ScheduledTask> {
    const res = await fetch(`${baseUrl.value}/scheduler/${agentId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(task),
    });
    if (!res.ok) throw new Error(`Failed to create scheduled task: ${res.status}`);
    return res.json();
  }

  async function updateScheduledTask(
    agentId: string,
    taskId: string,
    patch: Partial<Omit<ScheduledTask, "id" | "agentId">>
  ): Promise<ScheduledTask> {
    const res = await fetch(`${baseUrl.value}/scheduler/${agentId}/${taskId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(`Failed to update scheduled task: ${res.status}`);
    return res.json();
  }

  async function deleteScheduledTask(agentId: string, taskId: string): Promise<void> {
    const res = await fetch(`${baseUrl.value}/scheduler/${agentId}/${taskId}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`Failed to delete scheduled task: ${res.status}`);
  }

  function connect(agentId: string, sessionId: string, handlers: WebSocketHandlers): Connection {
    const wsUrl = baseUrl.value.replace(/^http/, "ws");
    const socket = new WebSocket(`${wsUrl}/ws/${agentId}?sessionId=${encodeURIComponent(sessionId)}`);

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
          case "think.delta":
            handlers.onThinkingDelta?.(data.delta);
            break;
          case "tool.call":
            handlers.onToolCall?.(data);
            break;
          case "tool.result":
            handlers.onToolResult?.(data);
            break;
          case "step.end":
            handlers.onStepEnd?.(data.finishReason);
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
        }
      },
      close() {
        socket.close();
      },
    };
  }

  // Blueprints
  async function listBlueprints(): Promise<Blueprint[]> {
    const res = await fetch(`${baseUrl.value}/blueprints`);
    if (!res.ok) throw new Error(`Failed to list blueprints: ${res.status}`);
    return res.json();
  }

  async function createBlueprint(blueprint: Omit<Blueprint, "id" | "createdAt" | "updatedAt">): Promise<Blueprint> {
    const res = await fetch(`${baseUrl.value}/blueprints`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(blueprint),
    });
    if (!res.ok) throw new Error(`Failed to create blueprint: ${res.status}`);
    return res.json();
  }

  async function getBlueprint(id: string): Promise<Blueprint> {
    const res = await fetch(`${baseUrl.value}/blueprints/${id}`);
    if (!res.ok) throw new Error(`Failed to get blueprint: ${res.status}`);
    return res.json();
  }

  async function updateBlueprint(id: string, patch: Partial<Blueprint>): Promise<Blueprint> {
    const res = await fetch(`${baseUrl.value}/blueprints/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(`Failed to update blueprint: ${res.status}`);
    return res.json();
  }

  async function deleteBlueprint(id: string): Promise<void> {
    const res = await fetch(`${baseUrl.value}/blueprints/${id}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`Failed to delete blueprint: ${res.status}`);
  }

  async function executeBlueprint(id: string, initialInput?: string): Promise<BlueprintExecution> {
    const res = await fetch(`${baseUrl.value}/blueprints/${id}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initialInput }),
    });
    if (!res.ok) throw new Error(`Failed to execute blueprint: ${res.status}`);
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
            handlers.onTextDelta?.(data.delta);
            break;
          case "think.delta":
            handlers.onThinkingDelta?.(data.delta);
            break;
          case "tool.call":
            handlers.onToolCall?.(data);
            break;
          case "tool.result":
            handlers.onToolResult?.(data);
            break;
          case "step.end":
            handlers.onStepEnd?.(data.finishReason);
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
        }
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
