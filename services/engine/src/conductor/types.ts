export interface Session {
  id: string;
  name: string;
  agentIds: string[];
  type: "group" | "intermind";
  createdAt: string;
  updatedAt: string;
}
