import type {
  IAgentRepository,
  IMessageRepository,
  IMemoryRepository,
  IActionRepository,
  ILLMCallRepository,
} from "../memory/repositories/types.js";
import type { AgentWorker } from "../core/agent-worker.js";
import type { ConfigRepository } from "../config/repository.js";

export interface ApiContext {
  agentRepository: IAgentRepository;
  getMessageRepository(agentId: string): IMessageRepository;
  getMemoryRepository(agentId: string): IMemoryRepository;
  getActionRepository(agentId: string): IActionRepository;
  getLLMCallRepository(agentId: string): ILLMCallRepository;
  configRepository: ConfigRepository;
  getAgentWorker(agentId: string): Promise<AgentWorker | undefined>;
}
