import { logger } from "../logger.js";
import { randomUUID } from "node:crypto";
import {
  HANDOFF_RESUME_DELAY_MS,
  isActiveHandoff,
  makeHandoffId,
  type HandoffBookInfo,
  type HandoffRecord,
} from "./types.js";
import type { HandoffManager } from "./manager.js";

export interface HandoffResumeLoopDeps {
  manager: HandoffManager;
  /** 续跑入队延迟（测试注入 0；缺省 600ms 给前端"换班中"可感知窗口） */
  delayMs?: number;
  /**
   * 入队续跑 job（ws 层接线：加载历史 → worker.enqueue；jobId 由本 loop 生成，
   * 保证 markStatus(running, { resumeJobId }) 与 worker job id 同源）。
   * signal 由 loop 持有，用户消息/disconnect 时 abort（含排队未启动的 job）。
   * chainId = 本链代际标记（F1）：续跑 job 继承当前链，撞顶 book 带同一代际。
   */
  enqueueResume(record: HandoffRecord, signal: AbortSignal, jobId: string, chainId?: string): void;
  /** 状态变化事件（ws 层转成 handoff.update 帧；失败只记 warn 不阻断状态机） */
  onUpdate?: (record: HandoffRecord) => void;
}

/**
 * 换班续跑循环（水位撞顶=换班不死）：
 * - handoff.book 事件 → 交接书入控制面（manager.record）→ 保险丝判定：
 *   shift >= maxShifts → fused（不再续跑）；否则 scheduled → 延迟 → running →
 *   enqueueResume（交接书置顶注入由 worker 完成）；
 * - 续跑 job 再撞顶 → 下一棒 book 事件替换 current，链继续；
 * - 续跑 job 正常完成（无新 book）→ completed；
 * - 用户消息/disconnect → cancel：清定时器 + abort 信号 + 控制面标 aborted。
 *
 * 状态机只在这里驱动；落盘/查询全走 HandoffManager。
 */
export class HandoffResumeLoop {
  private current?: {
    record: HandoffRecord;
    timer?: ReturnType<typeof setTimeout>;
    controller: AbortController;
    /** 本 job 已产出交接书（handleBook 先于 onDone 到达时的同步标记，防状态闪回） */
    booked?: boolean;
    /** 本链代际标记（F1）：首棒入控制面时确定，续跑棒继承，abort 后作废 */
    chainId?: string;
  };
  /** 当前链代际（F1）：abort/断连时清空，新用户消息经 beginNewChain 换新 */
  private currentChainId: string | undefined;

  constructor(private deps: HandoffResumeLoopDeps) {}

  /** worker 撞顶产出交接书（job.onEvent 拦截点调用；返回落盘+调度完成的 Promise） */
  onWatermarkBook(info: HandoffBookInfo): Promise<void> {
    return this.handleBook(info);
  }

  /**
   * 用户消息新链入口（F1）：为入队的新 job 签发新代际。
   * abort 之后新链的 book 带此代际 → 入口闩锁放行；
   * 旧链在途 job 的迟到 book 带旧代际 → 入口闩锁拦截。
   *
   * 2026-08-10 语义修正（P1-4）：只在「打断了在途活跃链」（该 agent+session
   * 存在 pending/scheduled/running 条目）时轮换；无活跃链时不轮换——
   * 沿用当前值，从未签发过才按需生成。用户连发两条消息、第一条的 job 后撞顶
   * 产 book 时，两条消息共用同一代际，book 不会被闩锁误杀。
   */
  beginNewChain(agentId: string, sessionId: string): string {
    if (this.deps.manager.activeFor(agentId, sessionId)) {
      this.currentChainId = randomUUID();
    } else if (this.currentChainId === undefined) {
      this.currentChainId = randomUUID();
    }
    return this.currentChainId;
  }

  private async handleBook(info: HandoffBookInfo): Promise<void> {
    try {
      // A1/F1 代际闩锁（入口复核）：
      // - 条目已 aborted：只放行「abort 之后新链」的 book（代际 = 当前链代际，
      //   beginNewChain 签发）；旧链迟到 book（旧代际/无代际）直接返回不调度。
      // - 条目非 aborted 但代际不符：并发旧链迟到 book 晚于新链 record 到达时，
      //   状态已非 aborted，仍按代际拦截，不得覆盖成 pending 复活旧链。
      // 落盘窗口内的复核（下方 latest.status !== "pending"）是第二道防线。
      // V4：lost 与 aborted 同为终态（重启对账后现场已毁），旧链迟到 book
      // 同样只在代际匹配当前链时才放行——reconcile 语义不变。
      // M38：fused 也是终态（保险丝撞顶停跑），纳入同一闩锁分支——fused 时
      // 本链代际已作废（下方保险丝分支清 currentChainId），旧链迟到 book
      // 一律代际不符被拦，不再覆盖成 pending 复活已烧断的链。
      // P2-1（2026-08-10 复审残余）：活跃 record 的持久化 chainId 是权威锚点——
      // 双 tab 先后发消息时各 loop 本地 currentChainId 可能各自不同，B 的 book
      // 即便与 B 本地代际相同也会顶替 A 的 record；改为比对 record chainId，
      // 只有同链 book 才能覆盖/续跑。
      const existing = this.deps.manager.get(makeHandoffId(info.agentId, info.sessionId));
      if (
        existing !== undefined &&
        isActiveHandoff(existing.status) &&
        existing.chainId !== undefined
      ) {
        if (info.chainId !== existing.chainId) return;
      } else if (
        existing?.status === "aborted" ||
        existing?.status === "lost" ||
        existing?.status === "fused"
      ) {
        if (info.chainId === undefined || info.chainId !== this.currentChainId) return;
      } else if (
        existing !== undefined &&
        info.chainId !== undefined &&
        info.chainId !== this.currentChainId
      ) {
        // 兼容迁移期旧数据（活跃 record 无 chainId）：退回本地代际比对
        return;
      }
      // 先同步标记：交接书事件可能早于旧 job 的 onDone 完成落盘，
      // onJobDone 看到 booked 就跳过 completed（链继续，由本函数接管）
      if (this.current) this.current.booked = true;
      const record = await this.deps.manager.record(info);
      this.deps.onUpdate?.(record);
      // P1-2 竞态修复：record 落盘窗口内，cancel（用户消息/断连/REST）可能已把
      // 本条目标 aborted，或更新的交接书已替换条目——调度前复核，绝不复活。
      const latest = this.deps.manager.get(record.id);
      if (!latest || latest !== record || latest.status !== "pending") {
        return;
      }
      // 保险丝：棒数撞顶（shift >= maxShifts）→ fused，不再调度下一棒
      if (record.shift >= record.maxShifts) {
        this.current = undefined;
        // M38：fused 是终态——本链代际随链一并作废。不清的话新链 beginNewChain
        // 会沿用 fused 链旧代际（无活跃链不轮换，P1-4），旧链迟到 book 与新链
        // 同代际无法区分（代际区分力下降）；作废后新链必签发新代际。
        this.currentChainId = undefined;
        const fused = await this.deps.manager.markStatus(record.id, "fused");
        if (fused) this.deps.onUpdate?.(fused);
        logger.info(
          { agentId: record.agentId, sessionId: record.sessionId, shift: record.shift, maxShifts: record.maxShifts },
          "[handoff] 棒数保险丝撞顶：停止自动续跑",
        );
        return;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => {
        void this.startResume(record);
      }, this.deps.delayMs ?? HANDOFF_RESUME_DELAY_MS);
      // 替换 current：上一棒（无论正常完成还是撞顶）的定时器/句柄随覆盖清理
      const prev = this.current;
      if (prev?.timer !== undefined) clearTimeout(prev.timer);
      this.current = { record, timer, controller, chainId: info.chainId };
      if (info.chainId !== undefined) this.currentChainId = info.chainId;
      const scheduled = await this.deps.manager.markStatus(record.id, "scheduled");
      if (scheduled) this.deps.onUpdate?.(scheduled);
    } catch (err) {
      logger.error({ err }, "[handoff] 交接书入控制面失败（本轮不自动续跑）");
      // M38：错误收尾统一走本 loop 的仲裁入口（registry 仲裁面对单 loop 的作用
      // 就是 loop.cancel(global: true)，此处同语义复用）：清定时器/abort 在途
      // job/作废旧代际 + 控制面 aborted + onUpdate，不再直连 manager.cancel
      // 漏掉本地资源清理。多 loop 扇出由控制面 aborted + 各 loop 复核兜底（V1/V5）。
      await this.cancel(info.agentId, info.sessionId, "record_failed").catch(() => {});
    }
  }

  private async startResume(record: HandoffRecord): Promise<void> {
    const cur = this.current;
    if (!cur || cur.record.id !== record.id) return; // 已被取消/被新棒覆盖
    // REST 手动打断等外部路径可能已把状态改为 aborted：入队前复核，避免续跑复活
    const latest = this.deps.manager.get(record.id);
    if (!latest || latest.status !== "scheduled") {
      this.current = undefined;
      return;
    }
    // P2-1：续跑身份复核——要续跑的 record chainId 必须与控制面权威代际
    // （latest.chainId）一致；不一致说明 record 已被其它链替换/覆盖，
    // warn 记档、不调度（防旧链定时器把新链顶掉）。
    const authorityChainId = latest.chainId;
    if (
      (record.chainId !== undefined &&
        authorityChainId !== undefined &&
        record.chainId !== authorityChainId) ||
      (cur.chainId !== undefined &&
        authorityChainId !== undefined &&
        cur.chainId !== authorityChainId)
    ) {
      logger.warn(
        {
          agentId: record.agentId,
          sessionId: record.sessionId,
          recordId: record.id,
          recordChainId: record.chainId,
          loopChainId: cur.chainId,
          authorityChainId,
        },
        "[handoff] startResume：续跑 record 代际与控制面权威代际不一致，不调度（warn 记档）",
      );
      this.current = undefined;
      return;
    }
    cur.timer = undefined;
    try {
      const resumeJobId = `handoff_resume_${randomUUID()}`;
      const running = await this.deps.manager.markStatus(record.id, "running", { resumeJobId });
      if (running) this.deps.onUpdate?.(running);
      this.deps.enqueueResume(record, cur.controller.signal, resumeJobId, cur.chainId);
    } catch (err) {
      logger.error({ err }, "[handoff] 续跑入队失败（标 aborted）");
      // M38：错误收尾统一走仲裁入口（语义同 registry.cancel 对本 loop 的作用）：
      // current 清理/abort/旧代际作废 + 控制面 aborted + onUpdate 一次完成
      await this.cancel(record.agentId, record.sessionId, "enqueue_failed");
    }
  }

  /**
   * 续跑 job 收尾（job.onDone 调用；record = 该 job 入队时的记录对象）：
   * - 该 job 又撞顶（current 已被下一棒替换）→ 链继续，无事可做；
   * - 该 job 正常完成 → 控制面标 completed，链结束；
   * - 异常（abort 除外）→ 标 aborted，链结束。
   */
  async onJobDone(
    record: HandoffRecord,
    agentId: string,
    sessionId: string,
    err?: unknown,
  ): Promise<void> {
    const cur = this.current;
    // 稳定 id 复用（同 agent+session 单条目）：棒次不同 = 已被下一棒替换，链继续
    if (!cur || cur.record.id !== record.id || cur.record.shift !== record.shift) return;
    // 本 job 已产出交接书：completed 由链的下一环（handleBook）接管，避免状态闪回
    if (cur.booked) return;
    // 代际复核（V5 恶性变体）：record 快照与控制面当前条目都必须与当前链代际
    // 一致，否则视为旧链迟到完成——warn 记档、不转移、不 throw。
    const latest = this.deps.manager.get(record.id);
    if (!latest) {
      logger.warn(
        { agentId, sessionId, recordId: record.id, shift: record.shift },
        "[handoff] onJobDone：控制面记录不存在，跳过收尾（记档不转移）",
      );
      return;
    }
    if (latest.status !== "running") {
      logger.warn(
        { agentId, sessionId, recordId: record.id, status: latest.status, shift: record.shift },
        "[handoff] onJobDone：状态非 running，跳过收尾（记档不转移）",
      );
      return;
    }
    if (
      cur.chainId !== undefined &&
      record.chainId !== undefined &&
      record.chainId !== cur.chainId
    ) {
      logger.warn(
        { agentId, sessionId, recordId: record.id, recordChainId: record.chainId, currentChainId: cur.chainId },
        "[handoff] onJobDone：job 快照代际与当前链不匹配（旧链迟到完成），跳过收尾",
      );
      return;
    }
    if (
      cur.chainId !== undefined &&
      latest.chainId !== undefined &&
      latest.chainId !== cur.chainId
    ) {
      logger.warn(
        { agentId, sessionId, recordId: record.id, recordChainId: latest.chainId, currentChainId: cur.chainId },
        "[handoff] onJobDone：控制面代际与当前链不匹配，跳过收尾",
      );
      return;
    }
    const isAbort = err !== undefined && cur.controller.signal.aborted;
    if (isAbort) return; // cancel() 已负责状态
    if (err !== undefined) {
      try {
        // M38：错误收尾统一走仲裁入口（语义同 registry.cancel 对本 loop 的作用）：
        // current 清理/abort/旧代际作废 + 控制面 aborted + onUpdate 一次完成
        await this.cancel(agentId, sessionId, "resume_failed");
      } catch (cancelErr) {
        logger.warn(
          { err: cancelErr, agentId, sessionId, recordId: record.id },
          "[handoff] onJobDone 失败收尾被拦截（记档不崩溃）",
        );
      }
      return;
    }
    this.current = undefined;
    try {
      const completed = await this.deps.manager.markStatus(record.id, "completed");
      if (completed) this.deps.onUpdate?.(completed);
    } catch (markErr) {
      // 非法转移（如复核窗口内被外部改成终态）：warn 记档，绝不浮空炸进程
      logger.warn(
        { err: markErr, agentId, sessionId, recordId: record.id },
        "[handoff] onJobDone 状态转移被拦截（记档不崩溃）",
      );
    }
  }

  /**
   * 打断：清定时器、abort 在途 job、控制面标 aborted。
   * opts.global === false（V3 连接级取消）：只作用于本连接资源（定时器/在途
   * job），不触碰全局 record——旧连接迟到 close 不得杀新连接活跃链。
   */
  async cancel(
    agentId: string,
    sessionId: string,
    reason: string,
    opts?: { global?: boolean },
  ): Promise<void> {
    const cur = this.current;
    const hadActive =
      cur !== undefined || this.deps.manager.activeFor(agentId, sessionId) !== undefined;
    if (cur) {
      if (cur.timer !== undefined) clearTimeout(cur.timer);
      cur.controller.abort();
      this.current = undefined;
    }
    // F1：打断即作废旧链代际——此后旧链在途 job 的迟到 book 一律被入口闩锁拦截。
    // 无活跃链时不轮换（P1-4）：背靠背消息共用代际，第一条撞顶 book 不被误杀。
    if (hadActive) this.currentChainId = undefined;
    if (opts?.global === false) return;
    const cancelled = await this.deps.manager.cancel(agentId, sessionId, reason);
    for (const c of cancelled) this.deps.onUpdate?.(c);
  }

  get active(): HandoffRecord | undefined {
    return this.current?.record;
  }
}
