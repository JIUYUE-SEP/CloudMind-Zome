import type { ZodTypeAny } from "zod";
import type { SubagentDispatcher } from "../subagent/dispatcher.js";
import type { SubagentSwarm } from "../subagent/batch.js";
import type { SkillService } from "../skills/service.js";
import type { ConfigRepository } from "../config/repository.js";
import type { PuppetModelService } from "../subagent/puppet-models.js";
import type { IntermindService } from "../intermind/service.js";

export interface ToolAccess {
  resource: "file" | "network" | "process" | "memory";
  action: "read" | "write" | "execute";
  path?: string;
}

/** 可注入工具执行上下文的生产服务（按需在 bootstrap 组装） */
export interface ToolServices {
  subagentDispatcher?: SubagentDispatcher;
  /** swarm 批量派发（dispatch_subagent_batch 工具） */
  subagentSwarm?: SubagentSwarm;
  /** 技能目录/正文通道（skill 工具） */
  skillService?: SkillService;
  /** 系统设置（web_search 等工具读 tavilyApiKey 等全局配置） */
  configRepository?: ConfigRepository;
  /** Puppet 型号库（dispatch_subagent 的 puppetModel 参数查型号/可用列表） */
  puppetModelService?: PuppetModelService;
  /** Intermind 人形间私信（send_private_message 工具：写信/唤醒/会话检索） */
  intermindService?: IntermindService;
}

export interface ToolContext {
  agentId: string;
  workspaceDir: string;
  projectRoot?: string;
  /** puppet 上下文标记（傀儡无人格无社交权，send_private_message 硬拒） */
  isPuppet?: boolean;
  /** 本回合由私信唤醒触发：回信搭车（只入队、不再次唤醒对方） */
  intermindRide?: boolean;
  /** 返回 true 表示允许执行该工具调用；返回 false 则以 "Approval denied" 拒绝。 */
  approve: (toolName: string, args: unknown, toolCallId: string) => boolean | Promise<boolean>;
  services?: ToolServices;
}

export interface ToolResult {
  success: boolean;
  output?: unknown;
  error?: string;
}

export interface Tool {
  name: string;
  description: string;
  parameters: ZodTypeAny;
  accesses: ToolAccess[];
  /** 为 true 时，执行前需要人工审批（无审批通道的调用一律拒绝） */
  requiresApproval?: boolean;
  execute: (ctx: ToolContext, args: unknown) => Promise<ToolResult>;
}
