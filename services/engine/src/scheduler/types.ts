export interface ScheduledTask {
  id: string;
  agentId: string;
  description: string;
  prompt: string;
  cron: string;
  enabled: boolean;
  lastRunAt?: string;
  nextRunAt?: string;
  createdAt: string;
  updatedAt: string;
}
