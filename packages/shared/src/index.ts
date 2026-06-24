export interface AgentConfig {
  id: string;
  name: string;
  persona: string;
  model: string;
  skills: string[];
  tools: string[];
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: Array<{ type: "text"; text: string } | { type: "think"; think: string }>;
  createdAt: string;
}
