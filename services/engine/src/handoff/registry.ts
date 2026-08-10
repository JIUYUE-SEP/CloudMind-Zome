import type { HandoffResumeLoop } from "./resume-loop.js";

/**
 * 活跃续跑循环注册表（P1-1 修复）：
 * 本表是「loop 每连接一份 / record 全局单条目」不对称的仲裁面（2026-08-10）：
 * agent+session 维度的 cancel 协调入口，一次完成 ①全局 record 取消
 * ②该维度下所有连接的 loop 打断（清定时器 + abort 在途 job）。
 * REST DELETE /handoff/:id、用户消息、断连全部经此入口，不再存在
 * 「只扫本连接」的路径。
 *
 * loop 是每 WS 连接一个，manager 是全局；注册表是两者之间的唯一桥。
 */
export class HandoffLoopRegistry {
  private loops = new Map<string, Set<HandoffResumeLoop>>();

  private static key(agentId: string, sessionId: string): string {
    return `${agentId}\u0000${sessionId}`;
  }

  register(agentId: string, sessionId: string, loop: HandoffResumeLoop): void {
    const key = HandoffLoopRegistry.key(agentId, sessionId);
    let set = this.loops.get(key);
    if (!set) {
      set = new Set();
      this.loops.set(key, set);
    }
    set.add(loop);
  }

  unregister(agentId: string, sessionId: string, loop: HandoffResumeLoop): void {
    const set = this.loops.get(HandoffLoopRegistry.key(agentId, sessionId));
    if (!set) return;
    set.delete(loop);
    if (set.size === 0) this.loops.delete(HandoffLoopRegistry.key(agentId, sessionId));
  }

  /**
   * 统一仲裁入口（用户消息 / REST DELETE）：打断该 agent+session 的全部
   * 活跃 loop（多连接场景不遗漏），并落控制面标 aborted。
   * 无 loop 时为空操作（调用方以 manager.abort/cancel 兜底）。
   */
  async cancel(agentId: string, sessionId: string, reason: string): Promise<void> {
    const set = this.loops.get(HandoffLoopRegistry.key(agentId, sessionId));
    if (!set) return;
    for (const loop of [...set]) {
      await loop.cancel(agentId, sessionId, reason, { global: true });
    }
  }

  /** 兼容旧名（REST 路径曾用 cancelAll；语义与 cancel 相同） */
  async cancelAll(agentId: string, sessionId: string, reason: string): Promise<void> {
    await this.cancel(agentId, sessionId, reason);
  }

  /**
   * 连接关闭专用（V3 半开重连）：
   * - 注销本连接 loop；
   * - 维度内还有其他「活跃链持有者」时，只取消本连接资源（定时器/在途 job），
   *   不触碰全局 record——旧连接迟到 close 不杀新连接活跃链；
   * - 无其他连接、或本连接是唯一活跃链持有者时，全局 record 一并取消。
   */
  async cancelConnection(
    agentId: string,
    sessionId: string,
    loop: HandoffResumeLoop,
    reason: string,
  ): Promise<void> {
    const key = HandoffLoopRegistry.key(agentId, sessionId);
    const set = this.loops.get(key);
    if (!set || !set.has(loop)) {
      // 未注册（异常路径兜底）：全量取消，不遗漏全局 record
      await loop.cancel(agentId, sessionId, reason, { global: true });
      return;
    }
    set.delete(loop);
    const remaining = set.size;
    if (remaining === 0) this.loops.delete(key);
    const ownsActive = loop.active !== undefined;
    const otherOwnsActive = [...set].some((l) => l.active !== undefined);
    if (remaining === 0 || (ownsActive && !otherOwnsActive)) {
      await loop.cancel(agentId, sessionId, reason, { global: true });
    } else {
      await loop.cancel(agentId, sessionId, reason, { global: false });
    }
  }
}
