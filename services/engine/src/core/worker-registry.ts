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
  /** 创建在途的 create promise（P3 review Major-2）：并发调用共享同一创建 */
  private inflightCreates = new Map<string, Promise<AgentWorker | undefined>>();
  /** create 期间收到的配置变更：workers 为空时 retire 无处落地，登记后补退役 */
  private pendingRetires = new Set<string>();

  /** 关停 drain 等场景枚举全部存活 worker */
  all(): AgentWorker[] {
    return [...this.workers.values()];
  }

  /** 配置变更：退役旧 worker（排队 job 显式 settle），在途排空信号入表 */
  retire(agentId: string): void {
    const worker = this.workers.get(agentId);
    if (worker) {
      worker.retire();
      this.workers.delete(agentId);
      this.retiringWorkers.set(
        agentId,
        worker.waitForIdle().finally(() => this.retiringWorkers.delete(agentId)),
      );
      return;
    }
    // Major-2：create 在途时 workers 为空，本次配置变更不能静默吞掉——
    // 登记下来，创建完成后按新配置再退役一次（下一次解析会拿到更新的配置重建）
    if (this.inflightCreates.has(agentId)) {
      this.pendingRetires.add(agentId);
    }
  }

  /**
   * 取 worker，不存在时用 create 创建。被替换 worker 的在途 turn 排空前
   * 不创建新的；create 在途的并发调用共享同一创建（P3 review Major-2：
   * 群聊无串行 chain，两条消息并发 await 同一 retiring promise 醒后
   * 曾确定性双双创建、后到 set 覆盖先到）。
   */
  async getOrCreate(
    agentId: string,
    create: () => Promise<AgentWorker | undefined>,
  ): Promise<AgentWorker | undefined> {
    const existing = this.workers.get(agentId);
    if (existing) return existing;
    // 并发共享同一 in-flight 创建，不另起
    const inflight = this.inflightCreates.get(agentId);
    if (inflight) return inflight;

    const retiring = this.retiringWorkers.get(agentId);
    if (retiring) {
      await retiring;
      // 等待期间可能已有 worker 或 in-flight create（并发调用抢先一步）
      const raced = this.workers.get(agentId) ?? this.inflightCreates.get(agentId);
      if (raced) return raced;
    }

    const promise = create();
    this.inflightCreates.set(agentId, promise);
    try {
      const worker = await promise;
      if (!worker) return undefined;
      this.workers.set(agentId, worker);
      // create 期间的配置变更补退役（否则该次变更被静默吞掉，
      // 用户拿到的还是变更前配置创建的 worker）
      if (this.pendingRetires.delete(agentId)) {
        this.retire(agentId);
      }
      return worker;
    } finally {
      this.inflightCreates.delete(agentId);
    }
  }
}
