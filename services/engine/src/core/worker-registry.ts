import type { AgentWorker } from "./agent-worker.js";

/**
 * worker 注册表（P3-6，配置变更竞态）：worker 生命周期的唯一权威——
 * 创建、替换、退役。bootstrap 的 onChange 调 retire()，取 worker 一律经
 * getOrCreate（WS 私聊每消息解析、群聊、scheduler、subagent 共用）。
 *
 * 竞态窗口语义：
 * - retire：旧 worker 排队 job 显式 settle（不挂起），在途 turn 继续跑完；
 * - getOrCreate：被替换 worker 的在途 turn 排空前不创建新 worker——
 *   两个 turn 不并发交错（FIFO 串行不变量）；
 * - 等待期间的新消息在 WS handler 的串行 chain 里排队，顺序不破。
 */
export class WorkerRegistry {
  private workers = new Map<string, AgentWorker>();
  private retiringWorkers = new Map<string, Promise<void>>();

  /** 关停 drain 等场景枚举全部存活 worker */
  all(): AgentWorker[] {
    return [...this.workers.values()];
  }

  /** 配置变更：退役旧 worker（排队 job 显式 settle），在途排空信号入表 */
  retire(agentId: string): void {
    const worker = this.workers.get(agentId);
    if (!worker) return;
    worker.retire();
    this.workers.delete(agentId);
    this.retiringWorkers.set(
      agentId,
      worker.waitForIdle().finally(() => this.retiringWorkers.delete(agentId)),
    );
  }

  /**
   * 取 worker，不存在时用 create 创建。被替换 worker 的在途 turn 排空前
   * 不创建新的；等待期间并发调用在排空后共享同一个新 worker（不重复创建）。
   */
  async getOrCreate(
    agentId: string,
    create: () => Promise<AgentWorker | undefined>,
  ): Promise<AgentWorker | undefined> {
    const existing = this.workers.get(agentId);
    if (existing) return existing;

    const retiring = this.retiringWorkers.get(agentId);
    if (retiring) {
      await retiring;
      const raced = this.workers.get(agentId);
      if (raced) return raced;
    }

    const worker = await create();
    if (!worker) return undefined;
    this.workers.set(agentId, worker);
    return worker;
  }
}
