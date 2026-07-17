import type {
  IAgentRepository,
  IMessageRepository,
  IMemoryRepository,
  IActionRepository,
  ILLMCallRepository,
} from "../memory/repositories/types.js";
import type { AgentWorker } from "../core/agent-worker.js";
import type { ConfigRepository } from "../config/repository.js";
import type { SessionRepository } from "../conductor/repository.js";
import type { BlueprintRepository } from "../blueprint/repository.js";
import type { PlanManager } from "../plan/manager.js";
import type { SubagentDispatcher } from "../subagent/dispatcher.js";
import type { BackgroundManager } from "../subagent/background.js";
import type { ChatMessage } from "@mindcloud/shared";

export interface ApiContext {
  agentRepository: IAgentRepository;
  getMessageRepository(agentId: string): IMessageRepository;
  getMemoryRepository(agentId: string): IMemoryRepository;
  getActionRepository(agentId: string): IActionRepository;
  getLLMCallRepository(agentId: string): ILLMCallRepository;
  configRepository: ConfigRepository;
  sessionRepository: SessionRepository;
  blueprintRepository: BlueprintRepository;
  getAgentWorker(agentId: string): Promise<AgentWorker | undefined>;
  listSkills?(): Promise<{ name: string; description: string; version: string }[]>;
  /** 按 agent 维度获取（懒创建）PlanManager；agent 不存在时返回 undefined */
  getPlanManager?(agentId: string): Promise<PlanManager | undefined>;
  /** 经 AgentWorker 队列运行一轮对话并收集最终文本（subagent/plan 执行共用）；signal 用于外部取消 */
  runAgentCollect?(agentId: string, messages: ChatMessage[], opts?: { signal?: AbortSignal }): Promise<string>;
  subagentDispatcher?: SubagentDispatcher;
  backgroundManager?: BackgroundManager;
}
