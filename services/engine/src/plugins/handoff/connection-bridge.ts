import { logger } from "../../logger.js";
import { HandoffResumeLoop } from "../../handoff/resume-loop.js";
import type { HandoffManager } from "../../handoff/manager.js";
import type { HandoffLoopRegistry } from "../../handoff/registry.js";
import type { HandoffBookInfo } from "../../handoff/types.js";
import type { AgentWorker } from "../../core/agent-worker.js";
import type { LLMEvent } from "../../provider/types.js";
import type { ChatMessage } from "@cloudmind/shared";

/**
 * 连接桥 deps（P7b 层间纪律）：连接特有物全部经回调注入——往 socket 发帧、
 * 非 book 帧透出（sanitizeDeltaEvent 留在 ws handler 侧）、历史加载、worker
 * 重新解析、连接建立时的 fallback worker。插件严禁 import api/*（层间倒置是
 * P2 专门清理过的，不得复活）。
 */
export interface HandoffConnectionDeps {
  agentId: string;
  sessionId: string;
  /** 往本连接 socket 发帧（handler 侧 safeSend 注入） */
  send(frame: object): void;
  /** 非 handoff.book 的 job 事件帧透出（handler 侧 sanitizeDeltaEvent + safeSend 注入） */
  sendJobEvent(event: LLMEvent): void;
  /** 加载本会话最近历史（limit 由 handoffHistoryLimit 随棒递减；失败回 []——原 .catch(() => []) 语义） */
  loadHistory(limit: number): Promise<ChatMessage[]>;
  /** 入队前重新解析 worker（P3-5；失败回 undefined——原 .catch(() => undefined) 语义） */
  resolveWorker(): Promise<AgentWorker | undefined>;
  /** 连接建立时解析到的 worker（重新解析失败时的回退引用） */
  fallbackWorker: AgentWorker;
}

/**
 * 续跑历史窗口随棒递减（路线图 §五 D1 欠账：原固定 limit 20，后棒上下文
 * 越攒越大）：第 N 棒续跑窗口 = max(5, 20 - (N-1)*5)——首棒 20 条语义不变，
 * 每换一班减 5 条、5 条兜底。依据：交接书本体（bookText 置顶注入）已承载
 * 跨棒长期上下文，热历史只需补最近衔接；递减窗口迫使后棒更多依靠交接书，
 * 与「换班 = 压缩继续」的设计同向。
 */
export function handoffHistoryLimit(nextShift: number): number {
  return Math.max(5, 20 - (nextShift - 1) * 5);
}

/**
 * 私聊连接桥（P7b）：原 api/ws/handler.ts 的 handoff 职责逐字语义收编——
 * 建 HandoffResumeLoop（onUpdate 帧 / enqueueResume 闭包）、注册进
 * HandoffLoopRegistry、handoff.book 拦截与 chainId 代际标记、断连
 * cancelConnection。「loop 每连接一份 / record 全局单条目」的不对称结构不变；
 * 仲裁调用点与调用顺序不变（用户消息先 registry cancel 再签发新链；断连走
 * cancelConnection；续跑历史加载失败收尾走 registry，R2 纪律）。
 */
export class HandoffConnectionBridge {
  private readonly loop: HandoffResumeLoop;

  constructor(
    private readonly deps: HandoffConnectionDeps,
    private readonly services: { manager: HandoffManager; loops: HandoffLoopRegistry },
  ) {
    const { agentId, sessionId } = deps;
    // 换班续跑循环（水位撞顶=换班不死）：控制面在 manager；
    // 调度/打断只在私聊连接上生效（群聊多 Agent 槽位语义留边界外）
    this.loop = new HandoffResumeLoop({
      manager: services.manager,
      onUpdate: (record) => {
        deps.send({
          type: "handoff.update",
          agentId,
          status: record.status,
          shift: record.shift,
          maxShifts: record.maxShifts,
          ...(record.bookMessageId !== undefined
            ? { bookMessageId: record.bookMessageId }
            : {}),
          ...(record.abortReason !== undefined ? { reason: record.abortReason } : {}),
        });
      },
      enqueueResume: (record, signal, jobId, chainId) => {
        void (async () => {
          if (signal.aborted) return;
          try {
            // 窗口随棒递减（handoffHistoryLimit）：record.shift 是刚写完交接书
            // 的一棒，续跑的是第 record.shift+1 棒
            const history = await deps.loadHistory(handoffHistoryLimit(record.shift + 1));
            if (signal.aborted) return;
            // P3-5 同范式：入队前重新解析 worker（配置变更后旧引用会被退役）
            const targetWorker = (await deps.resolveWorker()) ?? deps.fallbackWorker;
            targetWorker.enqueue({
              id: jobId,
              messages: history.length > 0 ? history : [],
              sessionId,
              signal,
              handoffResume: {
                shift: record.shift + 1,
                maxShifts: record.maxShifts,
                bookText: record.bookText,
              },
              // F1：续跑 job 继承当前链代际，撞顶 book 带同一 chainId 供闩锁判定
              onEvent:
                chainId !== undefined
                  ? (event) => this.onEventWithChain(event, chainId)
                  : (event) => this.onEvent(event),
              onDone: (err) => {
                // 2026-08-10：onJobDone 内部已做代际复核 + markStatus 防御，
                // 这里再兜一层 catch，绝不浮空 Promise 炸进程
                void this.loop.onJobDone(record, agentId, sessionId, err).catch((doneErr) => {
                  logger.warn(
                    { err: doneErr, agentId, sessionId },
                    "[handoff] onJobDone 意外异常已被捕获（不浮空）",
                  );
                });
              },
            });
          } catch (err) {
            logger.error({ err }, "[handoff] 续跑历史加载失败（不自动续跑）");
            // R2（P3-1）：失败收尾同样走 registry 仲裁入口——该 agent+session
            // 维度下所有连接的 loop 一并取消 + 全局 record 标 aborted，
            // 不再直连本连接 loop.cancel 绕过仲裁面。
            void services.loops.cancel(agentId, sessionId, "resume_history_failed");
          }
        })();
      },
    });
    // P1-1：注册到全局 loop 注册表，REST DELETE /handoff/:id 才能在 running 期
    // abort 在途 job；连接关闭时注销（断连 cancel 由 detach 完成）
    services.loops.register(agentId, sessionId, this.loop);
  }

  /** 单连接共享的 job 事件通道：拦截 handoff.book 交续跑循环，其余帧经回调透出前端 */
  onEvent(event: LLMEvent): void {
    if (event.type === "handoff.book") {
      const info: HandoffBookInfo = {
        agentId: this.deps.agentId,
        sessionId: this.deps.sessionId,
        reason: "watermark",
        shift: event.shift,
        maxShifts: event.maxShifts,
        used: event.used,
        window: event.window,
        bookMessageId: event.bookMessageId,
        bookText: event.bookText,
        chainId: event.chainId,
      };
      this.loop.onWatermarkBook(info);
      return;
    }
    this.deps.sendJobEvent(event);
  }

  /** F1：给 handoff.book 事件补链代际标记（入队时按 beginNewChain/当前链签发） */
  onEventWithChain(event: LLMEvent, chainId: string): void {
    if (event.type === "handoff.book") {
      this.onEvent({ ...event, chainId });
      return;
    }
    this.onEvent(event);
  }

  /**
   * 用户消息 = abort 打断 + 新链签发（原 handleMessage 调用序逐字保持）：
   * 先统一走 registry 仲裁面——该 agent+session 维度下所有连接的 loop 一并取消
   * （清定时器 + abort 在途 job）+ 全局 record 标 aborted；再 beginNewChain
   * 签发新代际（F1：只在打断了在途活跃链时轮换，无活跃链沿用当前代际——
   * P1-4 连发两条消息不误杀第一条的 book）。
   */
  async cancelUserMessage(): Promise<string> {
    const { agentId, sessionId } = this.deps;
    await this.services.loops.cancel(agentId, sessionId, "user_message");
    return this.loop.beginNewChain(agentId, sessionId);
  }

  /**
   * 断连收尾：统一走 registry 仲裁面（V3）——旧连接迟到 close 只取消本连接
   * 资源，只有无其他活跃连接时才落全局 record aborted（交接书仍在历史）。
   */
  detach(): void {
    const { agentId, sessionId } = this.deps;
    void this.services.loops.cancelConnection(agentId, sessionId, this.loop, "disconnect");
  }
}
