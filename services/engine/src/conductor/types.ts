import type { ChatMode } from "@mindcloud/shared";

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
