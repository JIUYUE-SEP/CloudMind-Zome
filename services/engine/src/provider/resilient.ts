import { logger } from "../logger.js";
import type { LLMProvider, LLMChatParams, LLMEvent, LLMProviderProtocol } from "./types.js";
import { ProviderError } from "./errors.js";
import { isRetryableError, isTurnAbortedError } from "./protocols/shared.js";

export interface ResilientProviderOptions {
  /** 同一 provider 的失败重试次数（ProviderConfig.maxRetries，默认 2）；备用 provider 同样享受 */
  maxRetries?: number;
  /** 备用 provider 链（AgentConfig.fallbackProviderIds），主 provider 重试耗尽后依次切换 */
  fallbackProviderIds?: string[];
  /** 按 providerId 创建备用实例（bootstrap 负责包 record 落档）；返回 undefined 跳过该备用 */
  fallbackFactory?: (providerId: string) => Promise<LLMProvider | undefined>;
  /** 测试注入：替换退避等待 */
  sleep?: (ms: number) => Promise<void>;
}

const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8_000;

/** 指数退避 500ms×2^n + jitter，上限 8s */
function backoffDelay(attempt: number): number {
  const jitter = Math.floor(Math.random() * 500);
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt + jitter);
}

/**
 * LLM 韧性装饰器：错误分类重试 + 备用 provider 降级链。
 *
 * 流式安全：只有「流产出首个事件之前」的失败可重试/降级——拿到首事件后
 * 失败直接上抛（重试会重复输出已上屏内容）。实现上先 next() 拉首事件，
 * 失败进重试逻辑，成功则 yield 首事件并循环转发剩余（之后的异常
 * 不在 catch 范围内，自然上抛）。
 *
 * 全链失败保持既有 UX：yield 一条用户可读错误文本 + step.end（用户看到
 * 告知、turn 正常收尾），再 throw 含完整尝试链的 ProviderError。
 */
export class ResilientLLMProvider implements LLMProvider {
  name: string;
  /** 当前活跃 provider（主 provider 重试耗尽后切换为备用；每次 chat 调用开始/结束复位为主） */
  private current: LLMProvider;

  constructor(
    private primary: LLMProvider,
    private options: ResilientProviderOptions = {},
  ) {
    this.name = primary.name;
    this.current = primary;
  }

  /**
   * S2：协议族标识跟随当前活跃 provider——降级到不同协议的备用后，水位预检
   * 口径（think 块是否占窗口）跟着换，不再固定主 provider 的协议。
   */
  get protocol(): LLMProviderProtocol | undefined {
    return this.current.protocol;
  }

  /** R2：主型号口径转发（runTurn 预检不变量检查用，取 primary 即 Router） */
  get defaultModel(): string | undefined {
    return this.primary.defaultModel;
  }

  /** R1：协议/路由口径刷新转发（Router 热更新；runTurn 预检前调用） */
  async refresh(): Promise<void> {
    await this.primary.refresh?.();
  }

  supportsModel(model: string): boolean {
    return this.primary.supportsModel(model);
  }

  /**
   * F1：每次新调用开始即复位协议口径——降级只影响当次调用链，新调用预检
   * （turn.ts 在 chat 前读 protocol）回到主 provider 协议；链结束（finally）
   * 再次复位，保证下一回合预检读到的也是主协议。
   */
  chat(params: LLMChatParams): AsyncIterable<LLMEvent> {
    this.current = this.primary;
    return this.chatChain(params);
  }

  private async *chatChain(params: LLMChatParams): AsyncIterable<LLMEvent> {
    try {
      const maxRetries = this.options.maxRetries ?? 2;
      const sleep =
        this.options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      const attempts: string[] = [];
      const fallbackIds = this.options.fallbackProviderIds ?? [];
      let fallbackIndex = 0;

      let current: LLMProvider | undefined = this.primary;
      while (current) {
        for (let attempt = 0; ; attempt++) {
          const iterator = current.chat(params)[Symbol.asyncIterator]();
          try {
            let first: IteratorResult<LLMEvent>;
            try {
              first = await iterator.next();
            } catch (err) {
              // 2026-11-01 P2：外部取消既不是重试的对象，也不是降级的理由——
              // 用户要求停就停，换个备用 provider 重跑语义荒谬。原样上抛，
              // 由 turn 收尾路径按「已中断」处理（不是故障）。
              if (isTurnAbortedError(err) || params.signal?.aborted) {
                throw err;
              }
              // 首事件前的失败才可重试/降级
              const retryable = isRetryableError(err);
              attempts.push(`${current.name}#${attempt + 1}: ${String(err)}`);
              if (retryable && attempt < maxRetries) {
                const delay = backoffDelay(attempt);
                logger.warn(
                  `[resilient] provider ${current.name} 第 ${attempt + 1} 次调用失败（可重试），${delay}ms 后重试：${String(err)}`,
                );
                await sleep(delay);
                continue;
              }
              if (!retryable) {
                logger.warn(`[resilient] provider ${current.name} 不可重试错误，直接降级/终态：${String(err)}`);
              }
              break;
            }
            // 首事件成功：yield 并转发剩余；此后失败直接上抛，绝不重试
            if (!first.done) yield first.value;
            for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
              yield next.value;
            }
            return;
          } finally {
            // P1-1：消费方中途 return（SSE 连接 cancel / record 包装器 finally 提前
            // 收尾）时，内层生成器必须显式 return()——否则其 finally（连接释放/清理）
            // 不会执行，产生悬挂连接与未收尾状态。
            if (iterator.return) {
              try {
                await iterator.return();
              } catch {
                // 内层收尾异常不阻断外层（避免二次抛错掩盖主路径）
              }
            }
          }
        }

        // 当前 provider 放弃 → 依次取备用
        const from = current.name;
        current = undefined;
        while (fallbackIndex < fallbackIds.length && !current) {
          const id = fallbackIds[fallbackIndex++];
          try {
            current = await this.options.fallbackFactory?.(id);
          } catch (err) {
            // 创建失败只记一条（含原因）——不再与「不可用」重复记账
            attempts.push(`fallback ${id}: 创建失败 ${String(err)}`);
            logger.warn(`[resilient] 备用 provider ${id} 创建失败，跳过：${String(err)}`);
            continue;
          }
          if (!current) attempts.push(`fallback ${id}: 不可用`);
        }
        if (current) {
          this.current = current;
          logger.warn(`[resilient] provider 降级：${from} → ${current.name}`);
        }
      }

      // 全链失败：保持既有 UX（用户可读告知 + step.end 正常收尾），再抛出含尝试链的错误
      yield { type: "text.delta", delta: "\n所有算力 Provider 均不可用，请稍后重试或检查算力配置。" };
      yield { type: "step.end" };
      throw new ProviderError("resilient", `全部 provider 失败，尝试链：${attempts.join(" | ")}`);
    } finally {
      this.current = this.primary;
    }
  }
}
