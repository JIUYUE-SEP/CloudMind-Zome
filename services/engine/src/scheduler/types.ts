import type { ChatMessage, ScheduledTask } from "@mindcloud/shared";
import type { LLMEvent } from "../provider/types.js";

export type { ScheduledTask };

export interface ScheduledTaskJob {
  id: string;
  messages: ChatMessage[];
  sessionId?: string;
  onEvent: (event: LLMEvent) => void;
  /**
   * job 执行结束回调（F5：执行期失败补偿的接入口）——err 为捕获到的异常，
   * 正常完成为 undefined。语义与 AgentWorker.Job.onDone 完全一致
   * （core/agent-worker.ts 的 Job 接口），runScheduledTask 入队时原样透传；
   * 类型保持 unknown 才能在 strictFunctionTypes 下与 Job.onDone 双向赋值。
   */
  onDone?: (err?: unknown) => void;
}
