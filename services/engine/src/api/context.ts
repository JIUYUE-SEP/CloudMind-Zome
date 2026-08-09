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
import type { HandoffManager } from "../handoff/manager.js";
import type { SidecarClient } from "../sidecar/client.js";
import type { McpClientManager } from "../tools/mcp/index.js";
import type { SkillService } from "../skills/service.js";
import type { PuppetModelService } from "../subagent/puppet-models.js";
import type { IntermindService } from "../intermind/service.js";
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
  /** 换班移交控制面（handoff-state.json）；WS 私聊续跑循环与 REST 共用 */
  handoffManager?: HandoffManager;
  /** sidecar gRPC 客户端（P1-3：删除 agent 时级联清理向量索引；dev/测试可缺省） */
  sidecarClient?: SidecarClient;
  /** MCP 工具 remember 判定查询（toolOverrides.allowRemember 放行；缺省/无 override 一律禁） */
  mcpManager?: McpClientManager;
  /** 技能目录/正文/调用记录通道（skill 工具与 skills 路由共用） */
  skillService?: SkillService;
  /** Puppet 型号库（GET /puppet-models） */
  puppetModelService?: PuppetModelService;
  /** Intermind 人形间私信（send_private_message 工具与 REST 共用） */
  intermindService?: IntermindService;
  /** 退役 agent 的 worker（skills/reload 复用配置变更的退役/重建机制：下次使用按新目录重建） */
  retireAgentWorker?(agentId: string): void;
}
