# Context Pipeline 重构任务

## 目标

重构 Agent 的上下文管理，实现"Hot Context 按场景隔离 + Zvec 全场景语义检索 + 逐层降级"的 Context Pipeline。

## 核心设计决策

1. **私聊和群聊的 Hot Context 分开**：私聊只加载私聊最近 N 条消息，群聊只加载群聊最近 N 条消息。不混合。
2. **语义检索跨场景**：每轮 LLM 调用前，用用户最新消息在 Zvec 中搜索全场景记忆，不区分来源。
3. **按需注入**：跨场景的检索结果按相关度打分，低于阈值的丢掉，高于阈值的注入 context。
4. **不搞场景检测**：当前只有私聊和群聊两个活跃场景，全场景检索 + 打分过滤就够了。等工作流场景真正用起来再考虑。

## Context Pipeline 流程

每轮 LLM 调用前，按以下顺序执行：

```
用户消息进来
    │
    ▼
Stage 1: Retriever
    - 用户最新消息做 embedding
    - 在 Zvec 中搜索全场景记忆（不按 source 过滤），取 top-K
    - 同时加载当前场景的 Hot Context（最近 N 条）
    │
    ▼
Stage 2: Scorer + Filter
    - 对 Zvec 返回的每条结果打分：
      - 基础分 = Zvec 语义相似度
      - 乘以时间衰减系数（越近越高）
      - 低于阈值（建议 0.3）的丢掉
    - 排序：当前场景的结果排前面，跨场景的排后面但不丢弃
    │
    ▼
Stage 3: Assembler + 降级
    - 按优先级把所有层拼成完整 prompt
    - 如果总长度超过模型 context window，逐层降级（见下方）
    │
    ▼
送给 LLM
```

## 逐层降级策略

不做 token 预算分配。按优先级组装，超了就逐层降级：

| 层级 | 内容 | 优先级 | 降级策略 |
|------|------|--------|----------|
| L0 | Identity 注入（`你是 {agent_name}`） | 最高 | 不降级 |
| L1 | Mind 文件（AGENT.md / SOUL.md 等） | 最高 | 不降级 |
| L2 | 行为指南（硬编码系统提示） | 最高 | 不降级 |
| L3 | 记忆路径提示（MEMORY.md 位置，非内容） | 最高 | 不降级 |
| L4 | Hot Context（当前场景最近 N 条） | 高 | 从最老的消息开始去掉：20→15→10 |
| L5 | 语义检索结果（Zvec top-K） | 中 | 从低分结果开始去掉：10→5→3 |
| L6 | 话题摘要（温/冷记忆） | 低 | 多条摘要合并成一条概要 |
| L7 | 工具描述 | 最高 | 不降级 |

**降级顺序：L6 → L5 → L4 → （L0/L1/L2/L3/L7 不动）**

降级流程：
1. 按优先级把所有层拼起来，算总长度
2. 超了 → 先压缩 L6 话题摘要（多条合并成一条概要）
3. 还超 → 减少 L5 top-K（从最低分结果开始去掉）
4. 还超 → 缩减 L4 Hot Context（从最老的消息开始去掉）
5. 正常情况下前两轮就够了

## 需要做的事

### 新增文件

- **`engine/context/context_pipeline.py`** — Context Pipeline 核心类，封装上述四个 Stage 的逻辑，替代现在 `_build_messages()` 中的上下文组装逻辑

### 需要修改的文件

- **`engine/agent/react.py`** — ReActAgent 核心循环：
  - 每轮 LLM 调用前，调用 ContextPipeline 组装 prompt
  - 现有的 `_build_messages()` 改为由 ContextPipeline 接管 L4-L7
  - Hot Context 需要按场景隔离加载（只取当前 source 的最近 N 条）
- **`engine/agent/message_builder.py`** — MessageBuilder：
  - 负责 L0-L3：Identity 注入、Mind 文件加载、硬编码行为指南、记忆路径提示（MEMORY.md 位置）
  - 群聊 user 消息加 `sender_name:` 前缀
- **`engine/memory/`** — 记忆系统：
  - 确认 Zvec 集成方式
  - `search()` 方法需要支持不按 source 过滤（搜全场景）
  - 返回结果需要包含 source 和 timestamp 信息
  - 支持传入 query_embedding（避免重复计算）
- **`engine/context/embedder.py`** — Embedder：
  - 需要支持对单条消息做 embedding（用于每轮的语义检索查询）

## 现有代码参考

请先阅读以下文件，理解现有实现后再动手：

- `engine/agent/react.py` — ReActAgent 核心循环，`_build_messages()` 是当前上下文组装逻辑
- `engine/agent/message_builder.py` — MessageBuilder，负责 L0-L3 + sender 前缀（`build()` 方法硬编码 L0-L3）
- `engine/memory/` — 记忆系统目录
- `engine/context/manager.py` — 现有 ContextManager（已删除）
- `engine/context/embedder.py` — Embedding 模型封装
- `app/services/agent_worker.py` — AgentWorker，Job 执行入口
- `app/services/job_queue.py` — AgentJob 定义，包含 source 和 source_name

## 约束

- **不要改 Job 结构**：source / source_name 已经足够标识场景
- **不要引入场景检测**：全场景检索 + 打分过滤即可
- **向后兼容**：如果 ContextPipeline 出错，降级到现有的 `_build_messages()` 逻辑
- **配置项**：`max_context_tokens` 放在 config.yaml 里，对应模型的 context window 大小；降级阈值（top-K 初始值、Hot Context 初始条数、相关度阈值）也放配置里，不要硬编码
- **代码风格**：跟项目现有风格保持一致，先读再写

## 验证方式

1. 私聊中问一个只有群聊讨论过的话题，Agent 应该能检索到并回答
2. 私聊正常对话时，context 不应包含群聊的无关消息
3. 对比重构前后的 LLM input token 数量，应该减少
4. Agent 回复质量不应下降（可人工评估）
