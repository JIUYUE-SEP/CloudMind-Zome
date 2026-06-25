import type { AgentConfig } from "@mindcloud/shared";

export interface ChatMessageRecord {
  id: string;
  role: "user" | "assistant" | "tool";
  content: Array<{ type: "text"; text: string } | { type: "think"; think: string }>;
  toolCalls?: { toolCallId: string; name: string; arguments: unknown }[];
  toolCallId?: string;
  createdAt: string;
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
  const baseUrl = options?.baseUrl || (config.public.engineUrl as string) || "http://127.0.0.1:8848";

  async function listAgents(): Promise<AgentConfig[]> {
    const res = await fetch(`${baseUrl}/agents`);
    if (!res.ok) throw new Error(`Failed to list agents: ${res.status}`);
    return res.json();
  }

  async function createAgent(agent: AgentConfig): Promise<AgentConfig> {
    const res = await fetch(`${baseUrl}/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(agent),
    });
    if (!res.ok) throw new Error(`Failed to create agent: ${res.status}`);
    return res.json();
  }

  async function getAgent(id: string): Promise<AgentConfig> {
    const res = await fetch(`${baseUrl}/agents/${id}`);
    if (!res.ok) throw new Error(`Failed to get agent: ${res.status}`);
    return res.json();
  }

  async function updateAgent(id: string, agent: AgentConfig): Promise<AgentConfig> {
    const res = await fetch(`${baseUrl}/agents/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(agent),
    });
    if (!res.ok) throw new Error(`Failed to update agent: ${res.status}`);
    return res.json();
  }

  async function deleteAgent(id: string): Promise<void> {
    const res = await fetch(`${baseUrl}/agents/${id}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`Failed to delete agent: ${res.status}`);
  }

  async function getMessages(agentId: string, sessionId: string, limit?: number): Promise<ChatMessageRecord[]> {
    const params = new URLSearchParams();
    params.set("sessionId", sessionId);
    if (limit) params.set("limit", String(limit));
    const res = await fetch(`${baseUrl}/chat/${agentId}/messages?${params.toString()}`);
    if (!res.ok) throw new Error(`Failed to get messages: ${res.status}`);
    return res.json();
  }

  function connect(agentId: string, sessionId: string, handlers: WebSocketHandlers): Connection {
    const wsUrl = baseUrl.replace(/^http/, "ws");
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

  return { listAgents, createAgent, getAgent, updateAgent, deleteAgent, getMessages, connect };
}
