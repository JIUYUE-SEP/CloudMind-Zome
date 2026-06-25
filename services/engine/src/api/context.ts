import type {
  IAgentRepository,
  IMessageRepository,
  IMemoryRepository,
  IActionRepository,
  ILLMCallRepository,
} from "../memory/repositories/types.js";
import type { AgentWorker } from "../core/agent-worker.js";

export interface ApiContext {
  agentRepository: IAgentRepository;
  getMessageRepository(agentId: string): IMessageRepository;
  getMemoryRepository(agentId: string): IMemoryRepository;
  getActionRepository(agentId: string): IActionRepository;
  getLLMCallRepository(agentId: string): ILLMCallRepository;
  getAgentWorker(agentId: string): AgentWorker | undefined;
}
