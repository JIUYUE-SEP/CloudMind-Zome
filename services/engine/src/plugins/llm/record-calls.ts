import { randomUUID } from "node:crypto";
import { logger } from "../../logger.js";
import type { LLMProvider, LLMChatParams, LLMEvent } from "../../provider/types.js";
import type { LLMCallRecord } from "../../memory/repositories/types.js";

export interface LLMCallSink {
  append(record: LLMCallRecord): Promise<void>;
}

export interface LLMCallProviderInfo {
  /** 真实 ProviderConfig.id（S5 身份核实：落档可溯源到配置条目） */
  providerId?: string;
  /** 真实 ProviderConfig.displayName（缺省回落 providerId/适配器名） */
  providerName?: string;
}

/**
 * LLM 调用落档装饰器（P4-5，架构 review LLMCallRepository 死代码）：
 * 包装 provider，每次 chat 调用记录一条 llm_calls.jsonl——时间、agent、
 * provider/model、流式全程耗时、token 用量（provider 经 step.end 透传
 * usage 时为真实值，拿不到记 0）、prompt+completion 合计、成功/失败与错误信息。
 * S5：providerInfo 透传真实 ProviderConfig.id/displayName；未传时回落适配器名。
 *
 * 热路径零阻塞：记录构造在流结束后进行，落盘 fire-and-forget，
 * 失败仅 warn（不影响 LLM 调用）。
 */
export function withLLMCallRecording(
  provider: LLMProvider,
  sink: LLMCallSink,
  agentId: string,
  providerInfo?: LLMCallProviderInfo,
): LLMProvider {
  const wrapped: LLMProvider = {
    name: provider.name,
    // 用 getter 而非值快照：Router 的 protocol 会随活配置热更新（R1），
    // resilient 降级切换当前 provider 时也要能取到对应协议（S2）
    get protocol() {
      return provider.protocol;
    },
    get defaultModel() {
      return provider.defaultModel;
    },
    supportsModel: (model: string) => provider.supportsModel(model),
    chat(params: LLMChatParams): AsyncIterable<LLMEvent> {
      const inner = provider.chat(params);
      return (async function* () {
        const startedAt = Date.now();
        let status: "ok" | "error" = "ok";
        let error: string | undefined;
        let promptTokens = 0;
        let completionTokens = 0;
        try {
          for await (const event of inner) {
            if (event.type === "step.end" && event.usage) {
              promptTokens = event.usage.promptTokens;
              completionTokens = event.usage.completionTokens;
            }
            yield event;
          }
        } catch (err) {
          status = "error";
          error = String(err);
          throw err;
        } finally {
          const record: LLMCallRecord = {
            id: `llm_${randomUUID()}`,
            agentId,
            provider: providerInfo?.providerName ?? provider.name,
            ...(providerInfo?.providerId !== undefined ? { providerId: providerInfo.providerId } : {}),
            model: params.model,
            promptTokens,
            completionTokens,
            totalTokens: promptTokens + completionTokens,
            durationMs: Date.now() - startedAt,
            status,
            ...(error !== undefined ? { error } : {}),
            createdAt: new Date(startedAt).toISOString(),
          };
          sink.append(record).catch((err: unknown) => {
            logger.warn({ err }, "[llm-call] 落档失败（已跳过，不影响主链路）");
          });
        }
      })();
    },
  };
  if (provider.refresh !== undefined) {
    wrapped.refresh = () => provider.refresh!();
  }
  return wrapped;
}
