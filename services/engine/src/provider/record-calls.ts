import { randomUUID } from "node:crypto";
import { logger } from "../logger.js";
import type { LLMProvider, LLMChatParams, LLMEvent } from "./types.js";
import type { LLMCallRecord } from "../memory/repositories/types.js";

export interface LLMCallSink {
  append(record: LLMCallRecord): Promise<void>;
}

/**
 * LLM 调用落档装饰器（P4-5，架构 review LLMCallRepository 死代码）：
 * 包装 provider，每次 chat 调用记录一条 llm_calls.jsonl——时间、agent、
 * provider/model、流式全程耗时、token 用量（provider 经 step.end 透传
 * usage 时为真实值，拿不到记 0）、成功/失败与错误信息。
 *
 * 热路径零阻塞：记录构造在流结束后进行，落盘 fire-and-forget，
 * 失败仅 warn（不影响 LLM 调用）。
 */
export function withLLMCallRecording(
  provider: LLMProvider,
  sink: LLMCallSink,
  agentId: string,
): LLMProvider {
  return {
    name: provider.name,
    protocol: provider.protocol,
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
            provider: provider.name,
            model: params.model,
            promptTokens,
            completionTokens,
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
}
