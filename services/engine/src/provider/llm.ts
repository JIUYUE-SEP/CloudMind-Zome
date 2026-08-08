import type { LLMProvider, LLMChatParams, LLMEvent } from "./types.js";
// OpenAIProvider 已于 2026-08-08 协议族迁移中归位到
// provider/protocols/openai-compatible-chat.ts（改名 OpenAICompatibleChatProvider）。
// 这里保留旧名 re-export 兼容既有测试/调用方；新代码请从 protocols/ 导入新名。
export {
  OpenAICompatibleChatProvider as OpenAIProvider,
  type OpenAICompatibleChatProviderOptions as OpenAIProviderOptions,
} from "./protocols/openai-compatible-chat.js";

/**
 * Provider 配置缺失时的占位实现。
 * 不用 Mock 伪装回复，而是明确告知用户配置问题，避免"假回复"写入历史。
 */
export class ErrorLLMProvider implements LLMProvider {
  name = "error";

  constructor(private message: string) {}

  supportsModel() {
    return true;
  }

  async *chat(): AsyncIterable<LLMEvent> {
    yield { type: "text.delta", delta: this.message };
    yield { type: "step.end" };
  }
}

export class MockLLMProvider implements LLMProvider {
  name = "mock";
  private nextToolCalls: Array<{ toolCallId: string; name: string; arguments: unknown }> = [];

  supportsModel(model: string) {
    void model;
    return true;
  }

  setNextToolCalls(toolCalls: Array<{ toolCallId: string; name: string; arguments: unknown }>): void {
    this.nextToolCalls = toolCalls;
  }

  async *chat(params: LLMChatParams): AsyncIterable<LLMEvent> {
    void params;
    if (this.nextToolCalls.length > 0) {
      for (const tc of this.nextToolCalls) {
        yield { type: "tool.call", ...tc };
      }
      this.nextToolCalls = [];
    } else {
      yield { type: "text.delta", delta: "Hello from mock" };
    }
    yield { type: "step.end" };
  }
}
