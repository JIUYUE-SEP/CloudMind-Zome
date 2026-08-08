# opencode Provider 协议族耦合评估（2026-08-08）

> 背景：CMZ provider 目前只有 chat completions 单协议（`provider/llm.ts`）——
> flash 在该路径吐 DSML 纯文本工具调用（8-01 实证）。定案按 opencode
> `packages/llm/src/protocols/` 的协议族形状迁移。本文是先于搬法的耦合评估：
> 依赖干净就直搬源码适配；拖家带口就仿写。

## 结论：仿写（结构照抄，实现按 CMZ 基建）

opencode 协议层与自家基建深度耦合，直搬源码意味着把 effect / sst 运行时、
Route 抽象和一套完全不同的 LLM 事件模型一起搬进 CMZ——收益远小于成本。
最终落地为：**协议形状照抄**（请求下降 + 流式事件状态机 + usage 映射三层结构），
**传输与事件产出按 CMZ 现有基建重写**（Node fetch + 手写 SSE + CMZ `LLMEvent`）。

## 耦合点清单

| opencode 依赖 | 用途（protocols/ 内） | CMZ 现状 | 影响 |
|---|---|---|---|
| `effect`（Effect/Schema/Stream） | 全部协议文件的请求 Schema、Effect.fn 下降、`Effect.forEach`、错误通道 | engine 无 effect 依赖 | 直搬需新增运行时依赖并重写全部函数签名 |
| `effect/unstable/encoding/Sse` + `effect/unstable/http` | `shared.ts` 的 `sseFraming`、`jsonPost`（SSE 解码、HTTP 客户端） | OpenAI SDK（chat）/ 无原生 SSE（responses/anthropic 需新增） | 直搬会把 SSE 通道和 HTTP 栈一起带进来 |
| `../route/*`（Route/Endpoint/Protocol/HttpTransport/WebSocketTransport/Framing/Auth） | 协议注册、端点拼 URL、transport 组合 | 无对应抽象，bootstrap 直接实例化 provider | 整个 route 层是 opencode 自家抽象，CMZ 不需要 |
| `../schema`（LLMRequest/LLMEvent/Usage/ToolCall/ContentPart） | 请求/事件的统一类型 + `LLMEvent.toolCall()` 等构造器 | CMZ `provider/types.ts` 只有 6 种 `LLMEvent`（text.delta / thinking.delta / tool.call / tool.result / step.end / turn.end） | 事件模型差异最大：opencode 有 textStart/End、reasoningStart/Delta/End、toolInputStart/Delta/End、stepStart/Finish、finish 等十余种事件 |
| `utils/tool-stream.ts` | 流式工具参数累加器（按 index/item_id 稀疏状态 + finish 解析） | llm.ts 内联 Map 累加器 | 逻辑可移植，但被 Effect 包装（`Effect.gen`/`LLMError`） |
| `utils/lifecycle.ts` | 事件生命周期（text/reasoning 开闭、step start/finish） | 无（CMZ 事件无开闭） | 整体不需要，降为直接产出 delta |
| `utils/openai-options.ts` / `tool-schema.ts` / `cache.ts` | 供应商选项、JSON Schema 投影、Anthropic cache_control | 无对应概念（CMZ 不传 cache 选项；工具 schema 由 `zodToJsonSchema` 生成） | 按需裁剪 |
| `sst-env.d.ts` / `@tsconfig/bun` | 构建环境 | CMZ 用 Node16 + tsc | 无关 |

## 直搬不可行的三个硬理由

1. **事件协议不兼容**：opencode 消费自己的 `LLMEvent` 富事件流；CMZ 上层
   （worker/压缩/裁判）只认 6 种事件。即便搬来协议文件，也必须在输出侧重写
   一层映射——等于仿写。
2. **effect 贯穿全部函数签名**：请求下降与流式 step 都是 `Effect.fn` / 
   `Effect.gen`，错误通道是 `LLMError`。CMZ 的错误语义是 `ProviderError` +
   `retryable` 分类，两者无法透明互操作。
3. **route/transport 是 opencode 私货**：CMZ 的边界在 `LLMProvider` 接口
   （`chat(): AsyncIterable<LLMEvent>`），不需要 URL/鉴权/传输的组合抽象。

## 落地对照（结构照抄的部分）

三个适配器统一实现既有 `LLMProvider` 接口，上层零改动：

```
services/engine/src/provider/protocols/
├── shared.ts                    # SSE 解析、JSON POST、工具参数解析、错误包装
├── openai-compatible-chat.ts    # 兼容层：llm.ts 原逻辑整体归位 + 改名（行为不变）
├── openai-responses.ts          # 主路新推荐：POST {baseURL}/responses
├── anthropic-messages.ts        # 主路：POST {baseURL}/anthropic/v1/messages
└── index.ts                     # createProtocolProvider(apiMode) 工厂
```

请求下降结构照抄 opencode（`lowerMessages` / `lowerTools` / 中段 system 降级为
`<system-update>` 可见 user 文本）；流式解析照抄其状态机骨架（tool 按流内
key 累加、`content_block_stop` / `output_item.done` 定稿、终态事件落 usage）。

## DeepSeek 官方文档交叉核对（不连真 API）

### Responses API（api-docs.deepseek.com/guides/responses_api）

- `base_url = https://api.deepseek.com`，端点 `POST /responses`；
- `input` 支持字符串或 item 列表；`instructions` 等价首条 system；
- item 支持 `message`（user/assistant/system/developer）、`function_call`、
  `function_call_output`、`reasoning`（**plain-text content**，summary 不支持）；
- 流式：`response.output_text.delta` / `response.reasoning_text.delta` /
  `response.function_call_arguments.delta` / `response.output_item.added|done`；
  终态 `response.completed` / `response.incomplete` / `response.failed`，**无 [DONE]**；
- usage：终态 `response.usage.input_tokens`（含 cached_tokens 明细）/
  `output_tokens`（含 reasoning_tokens 明细）；
- 目前仅 `deepseek-v4-flash` 支持 Responses；`stream_options` 不支持（忽略）。

### Anthropic API（api-docs.deepseek.com/guides/anthropic_api）

- `base_url = https://api.deepseek.com/anthropic`，端点 `POST /v1/messages`；
- 鉴权 `x-api-key`；`anthropic-version` 忽略（仍发送兼容原生 Anthropic）；
- content 支持 text / thinking（signature 可缺省）/ tool_use（id/name/input）/
  tool_result（tool_use_id/content，is_error 忽略）；
- `system` 独立字段、`max_tokens` 必填；`temperature`/`top_p` 支持，`top_k` 忽略；
- tools：name / description / input_schema（cache_control 忽略）；
- 流式标准 Anthropic SSE：message_start → content_block_start/delta/stop →
  message_delta（stop_reason + usage）→ message_stop；
- Claude 型号名自动映射（claude-opus* → v4-pro；claude-* → v4-flash）。

## 与 opencode 实现的有意差异（注释已写明）

1. `openai-responses`：reasoning 输入 item 用 DeepSeek 的 `content` 字段而非
   OpenAI `summary`（官方文档明示不支持 summary）；不发送 `strict:false`
   （DeepSeek 未列 strict 支持，避免被严格校验网关拒绝）。
2. `anthropic-messages`：不发送 cache_control（DeepSeek 忽略）；thinking 不带
   signature（DeepSeek 不要求回传）；tool_result 的 is_error 按文档忽略。
3. 端点归一：baseUrl 为 DeepSeek 根域时拼 `/anthropic/v1/messages`，
   以 `/anthropic` 或 `/anthropic/v1` 结尾时不再重复拼接。

## 遗留说明

- chat 兼容层保留 OpenAI SDK（行为零变化），`llm.ts` 保留旧名
  `OpenAIProvider` re-export 供既有测试/调用方过渡，新代码走新名。
- DSML 现象修复的完整闭环（responses/anthropic 主路切换 + 兜底解析）不在本次
  协议族迁移范围内；本次只提供两条可绕开 chat 路径的主路协议与 apiMode 切换机制。
