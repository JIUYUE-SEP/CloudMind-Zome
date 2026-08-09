import type { HandoffResumeLoop } from "./resume-loop.js";

/**
 * 活跃续跑循环注册表（P1-1 修复）：
 * REST DELETE /handoff/:id 与用户消息/断连同语义——通过本表找到该
 * agent+session 上的活跃 HandoffResumeLoop，调 loop.cancel 清定时器 +
 * abort 在途 job + 控制面标 aborted（running 期也能真正打断）。
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

  /** 打断该 agent+session 的全部活跃 loop（多连接场景不遗漏）；无 loop 时为空操作 */
  async cancelAll(agentId: string, sessionId: string, reason: string): Promise<void> {
    const set = this.loops.get(HandoffLoopRegistry.key(agentId, sessionId));
    if (!set) return;
    for (const loop of [...set]) {
      await loop.cancel(agentId, sessionId, reason);
    }
  }
}
