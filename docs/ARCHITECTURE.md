# CloudMind-Zome 架构文档

> Version: 2.0 | Date: 2026-06-02 | Branch: dev

---

## 1. 项目概述

CloudMind-Zome 是一个多 Agent 协作平台，核心设计理念是**"每个 Agent 是一个独立的数字生命"**。用户可以与单个 Agent 私聊，也可以创建群聊让多个 Agent 协作讨论。Agent 具备完整的记忆系统、工具调用能力、主动性（定时任务）。

### 1.1 核心特性

| 特性 | 说明 |
|------|------|
| **私聊** | 用户与单个 Agent 一对一对话，支持图片、引用回复 |
| **群聊** | 多 Agent 协作，支持 @mention、Agent 自主决策回复（stay_silent） |
| **工具调用** | Agent 可调用工具（搜索、文件操作、代码执行、生图等） |
| **算力平台** | 用户管理 LLM Provider（API Key、模型），与 Agent 配置打通 |
| **记忆系统** | Context Pipeline + zvec 语义检索 + Topic Compression 三层架构 |
| **主动性** | Commission（定时任务） |
| **无登录** | 纯访客模式，零门槛使用 |

---

## 2. 技术栈

### 2.1 后端

| 层级 | 技术 |
|------|------|
| 框架 | FastAPI + Uvicorn |
| ORM | SQLAlchemy 2.0 (async) |
| 数据库 | SQLite (`~/.cloudmind-zome/cloudmind.db`, WAL 模式) |
| 向量存储 | zvec (C++ HNSW，`~/.cloudmind-zome/zvec/`) |
| LLM 客户端 | OpenAI SDK (兼容 DeepSeek/MiMo/KimiCode/GLM) |
| 任务调度 | asyncio + 自定义轮询器 |

### 2.2 前端

| 层级 | 技术 |
|------|------|
| 框架 | Vue 3 + Vite |
| 状态管理 | Pinia |
| 路由 | Vue Router (hash 模式) |
| UI | 纯 CSS 自定义（科幻暗色主题） |
| 3D 渲染 | Three.js + @pixiv/three-vrm |
| 通信 | WebSocket (原生 API) |

---

## 3. 后端架构

### 3.1 目录结构

```
backend/
├── app/                    # 平台层 (Platform)
│   ├── api/               # REST + WebSocket API
│   ├── models/            # SQLAlchemy ORM 模型
│   ├── services/          # 业务服务
│   ├── main.py            # FastAPI 入口
│   └── database.py        # 数据库连接
├── engine/                # 引擎层 (Agent Engine)
│   ├── agent/             # ReActAgent 核心循环 + MessageBuilder
│   ├── context/           # ContextPipeline + zvec + Embedder
│   ├── memory/            # MemorySystem 插件 + TopicCompressionMemory
│   ├── personality/       # 人格提取（Big-5）+ 提示词构建
│   ├── provider/          # LLM Transport + Thinking Profile + Factory + Registry
│   ├── tool/              # 工具注册中心
│   ├── tools/             # 工具实现（搜索、代码、文件、通讯、群聊）
│   ├── message/           # 消息类型定义
│   ├── session/           # 持久化存储
│   ├── config/            # 配置加载
│   └── error/             # 错误分类与重试
└── run.py                 # 启动脚本
```

### 3.2 分层职责

```
┌─────────────────────────────────────────────────────────────┐
│  Frontend (Vue3)                                            │
│  - HTTP REST API  │  WebSocket (实时消息/状态)              │
└──────────┬────────────────────────────────┬─────────────────┘
           │                                │
           ▼                                ▼
┌──────────────────────────┐  ┌──────────────────────────────┐
│  Platform API (FastAPI)  │  │  WebSocket Manager           │
│  - /api/v1/auth/*        │  │  - chat.send                 │
│  - /api/v1/agents/*      │  │  - agent.stop                │
│  - /api/v1/chats/*       │  │  - 状态广播                  │
│  - /api/v1/config        │  │                              │
└──────────┬───────────────┘  └──────────┬───────────────────┘
           │                             │
           ▼                             ▼
┌─────────────────────────────────────────────────────────────┐
│  Platform Services                                          │
│  - EngineBridge        (平台请求 → Agent Worker)            │
│  - AgentWorker         (单 Agent 单 Task + FIFO Queue)      │
│  - JobQueue            (Job 定义 + 全局队列注册表)           │
│  - GroupChatRouter     (群聊路由: @mention / 语义)          │
│  - ConductorService    (队长管理群任务)                      │
│  - CommissionScheduler (定时任务调度)                        │
│  - EventBus            (全局状态广播)                        │
└────────────────────────────┬────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│  Agent Engine                                               │
│  - ReActAgent          (ReAct 循环 + 场景隔离记忆)           │
│  - ContextPipeline     (L0-L7 组装 + 逐层降级)              │
│  - ChatCompletionsTransport  (OpenAI API 调用)              │
│  - ToolRegistry        (工具注册/发现/执行)                  │
│  - TopicCompressionMemory (话题检测 + 异步压缩)              │
│  - SessionStore        (SQLite 持久化)                      │
└─────────────────────────────────────────────────────────────┘
```

---

## 4. 数据库模型

### 4.1 核心表

| 表名 | 说明 |
|------|------|
| `users` | 用户（访客模式固定 guest） |
| `agents` | Agent（数字生命实体） |
| `chat_sessions` | 会话（私聊/群聊） |
| `chat_messages` | 平台层消息记录 |
| `chat_session_members` | 会话成员关系 |
| `agent_messages` | Agent 引擎层统一记忆池（按 agent_id + source 存储） |
| `llm_sessions` | 引擎层会话统计 |
| `llm_messages` | 引擎层消息（与 agent_messages 互补） |
| `actions` / `action_runs` | 工作流蓝图与执行记录 |
| `commissions` / `commission_logs` | 定时任务与执行日志 |
| `compute_providers` | LLM 算力提供商配置（API Key、Base URL、模型列表） |
| `approvals` | 审批检查点 |

### 4.2 关键关系

```
User (1) ───< Agent (N)
           │
           └──< ChatSession (N, via ChatSessionMember)

ChatSession (1) ───< ChatMessage (N)
                 ───< ChatSessionMember (N)

Agent (1) ───< agent_messages (N, 统一记忆池，按 source 区分场景)
Agent (1) ───< compute_providers (N, 算力配置，用于构建 Transport)
```

---

## 5. Agent 架构详解

### 5.1 Agent = 单一数字生命

每个 Agent 对应全局唯一的 `AgentWorker`：

- **一个 asyncio.Task** — 串行处理所有 Jobs
- **一个 asyncio.Queue** — FIFO 队列，不区分优先级
- **一个 ReActAgent 实例** — 永不重建，持有场景隔离的记忆 `_messages`
- **一个状态** — idle / busy，由 Worker 单点维护

```python
# AgentWorker 核心循环
async def run(self):
    while self._running:
        job = await self.queue.get()   # FIFO
        await self._execute_job(job)   # 串行执行
```

**Job 类型**：
- `stream` — 正常对话，流式输出 content / thinking / tool_call
- `ingest_only` — 群聊消息广播，只写入记忆不生成回复

### 5.2 ReAct 循环

```
用户消息 → 加入 _messages → ContextPipeline 组装 Prompt → LLM 流式调用 → 解析响应
                                                              ↓
                                                    ┌─────────┴─────────┐
                                                    ↓                   ↓
                                              [普通回复]           [Tool Calls]
                                                    ↓                   ↓
                                              保存并结束          执行工具 → 结果加入 _messages
                                                                          ↓
                                                                  继续下一轮 LLM
```

**流式输出**：`transport.stream()` 逐 token 推送，`AgentEvent` 事件类型：
- `thinking` — 推理内容（折叠显示）
- `content` — 正文内容
- `tool_call` — 工具调用（折叠显示）
- `tool_result` — 工具执行结果
- `done` — 流结束

**消息持久化**：`ChatMessage` 新增 `tool_calls`（JSON）和 `reasoning`（Text）字段。`ws_handlers.py` 在流式结束后统一写入数据库，历史消息加载时完整还原。

### 5.3 消息模型 (Message)

```python
@dataclass
class Message:
    role: "user" | "assistant" | "system"
    content: list[ContentBlock]   # 自动将 str 包装为 [TextBlock]
    meta: MessageMeta
```

**ContentBlock 类型：**

| 类型 | 用途 |
|------|------|
| `TextBlock` | 普通文本 |
| `ThinkingBlock` | LLM 推理内容（不重复喂回） |
| `ToolUseBlock` | 工具调用（id 自动生成 UUID） |
| `ToolResultBlock` | 工具执行结果（id 必须匹配 ToolUseBlock） |
| `ImageBlock` | 图片（vision 模型） |

**MessageBuilder 消息拼装**：
- 私聊：`user` 消息不加前缀，直接送入历史
- 群聊：`user` 消息加 `sender_name:` 前缀（如 `小明: 大家好`）
- **MessageBuilder 负责 L0-L3**：Identity 注入（`你是 {agent_name}`）、Mind 文件加载、硬编码行为指南、记忆路径提示（MEMORY.md 位置）

**MessageMeta 字段：**
- `id` — 消息 UUID
- `session_id` / `source_id` — 场景标识
- `source` — "private" | "group" | "workflow"
- `source_name` — 场景显示名
- `sender_name` — 发送者显示名
- `timestamp` — 时间戳
- `compressed` — 是否为压缩摘要

### 5.4 Context Pipeline

`ContextPipeline` 是每轮 LLM 调用前的核心组装逻辑：

```
Stage 1: Retriever
  - 用户最新消息做 embedding
  - 在 zvec 中搜索全场景记忆（不按 source 过滤），取 top-K

Stage 2: Scorer + Filter
  - 基础分 = zvec 语义相似度
  - 乘以时间衰减系数（越近越高）
  - 低于阈值（默认 0.3）的丢掉
  - 排序：当前场景的结果排前面

Stage 3: Assembler
  - 按优先级 L1→L6 拼接完整 prompt
  - L0(Identity) + L1(Mind) + L2(指南) + L3(记忆路径) + L4(Hot) + L5(Semantic) + L6(Topics) + L7(Tools+人格)

Stage 4: Downgrade
  - 总 token 超限 → L6 合并 → L5 缩减 → L4 截断
  - L0/L1/L2/L3/L7 永不动
```

**场景隔离**：`_messages` 按 `source_id` 隔离，切换场景时清空重载。群聊中其他 Agent 的回复会通过 `ingest_only` Job 写入当前 Agent 的 `agent_messages`，确保群聊上下文同步。

**降级配置项**（`engine/config.yaml`）：
- `context.max_context_tokens` — 模型 context window（默认 128000）
- `context.semantic_search_top_k` — zvec 初始 top-K（默认 10）
- `context.semantic_score_threshold` — 最低相关度（默认 0.3）
- `context.hot_context_initial` — Hot Context 初始条数（默认 20）
- `context.time_decay_half_life_hours` — 时间衰减半衰期（默认 72h）

> 注：L0-L3 由 `MessageBuilder.build()` 硬编码注入（`engine/agent/message_builder.py:32-123`）；L4-L7 由 `ContextPipeline.assemble()` 插入（`engine/context/context_pipeline.py:169-220`）。

### 5.5 记忆系统

**三层架构：**

```
┌─────────────────────────────────────────────┐
│  Hot Context  (ReActAgent._messages)        │
│  - 按 source_id 场景隔离，内存中直接访问      │
│  - 切换场景时清空重载                         │
├─────────────────────────────────────────────┤
│  Semantic Memory  (zvec 向量)                │
│  - 每条消息自动 embedding                     │
│  - 跨场景语义相似度检索                       │
│  - 时间衰减打分，低于阈值过滤                 │
├─────────────────────────────────────────────┤
│  Topic Summaries  (_compressed/*.md)        │
│  - TopicMarker 检测话题切换                   │
│  - CompressionWorker 异步压缩生成             │
│  - 按修改时间排序，Pipeline L5 注入           │
└─────────────────────────────────────────────┘
```

**话题压缩流程：**
1. `TopicMarker` 分析最近消息，检测话题标签切换
2. 话题关闭时，`CompressionWorker` 异步生成摘要
3. 摘要保存为 `~/.cloudmind-zome/agents/{id}/_compressed/{topic}.md`
4. 摘要同时索引到 zvec `agent_topics` collection
5. 原始消息从 `agent_messages` 中删除（释放 token）

**压缩触发条件：**
- 上下文 token 数超过阈值（默认 80% of context window）
- `before_llm()` 中触发 `check_compression()`

### 5.6 工具系统

**10+ 内置工具：**

| 工具 | 功能 |
|------|------|
| `search_web` | Tavily 网络搜索 |
| `python_execute` | 执行 Python 代码 |
| `shell_command` | 执行 Shell 命令 |
| `read_file` | 读取文件 |
| `write_file` | 写入文件 |
| `delete_file` | 删除文件（移至回收站） |
| `share_file` | 分享文件到聊天 |
| `generate_image` | 生图（DALL-E / SiliconFlow 兼容） |
| `send_private_message` | Agent 间私信 |
| `report_workflow_progress` | 报告工作流进度 |
| `stay_silent` | 群聊中 Agent 决定不回复 |

**工具注册：** 使用 `@tool_registry.register()` 装饰器自动注册，支持从目录递归发现（AST 解析，支持别名 import）。

**工具执行：**
- 同步工具使用有界线程池（`ThreadPoolExecutor(max_workers=8)`）
- 异步工具直接 `asyncio.wait_for`
- 并行策略：所有工具标记为 `safe_to_parallel=true` 时并行执行

---

## 6. 通信架构

### 6.1 WebSocket 协议

**单连接，多路复用：**

```
Client ──WebSocket──► Server
  │
  ├──► chat.send        (发送消息)
  ├──► agent.stop       (暂停私聊 Agent)
  ├──► chat.typing      (输入状态)
  └──► agent.status     (订阅状态广播)

Server ──WebSocket──► Client
  │
  ├──► chat.message     (消息，含 tool_calls / reasoning)
  ├──► chat.thinking    (推理块)
  ├──► chat.tool_call   (工具调用)
  ├──► agent.status     (Agent 状态变更)
  └──► chat.typing      (对方输入中)
```

### 6.2 群聊路由

```
用户消息
    │
    ▼
┌─────────────────────┐
│ GroupChatRouter     │
│ - @mention 精确路由  │
│ - @所有人 / @all     │
│ - 语义意图路由       │
│ - 随机兜底           │
└──────────┬──────────┘
           │
           ▼
    选中的 Agent(s)
           │
           ▼
    并行 dispatch_job()
           │
           ▼
    各 Agent Worker 串行回复
```

### 6.3 跨 Agent 记忆同步

当 Agent A 在群聊中回复后，该交换（用户消息 + Agent A 回复）会被写入**所有其他 Agent** 的 `agent_messages` 表中（source="group"），确保每个 Agent 都能看到群聊上下文。

---

## 7. 前端架构

### 7.1 目录结构

```
frontend/src/
├── api/
│   └── client.ts          # 统一 HTTP 客户端
├── components/
│   ├── ChatView.vue       # 私聊组件
│   ├── GroupChatView.vue  # 群聊组件
│   ├── CommunicationHub.vue  # 通讯中枢（会话列表）
│   ├── AgentEdit.vue      # Agent 编辑
│   ├── ActionCenter.vue   # 工作流中心
│   ├── CommissionCenter.vue  # 定时任务
│   ├── SystemSettingsPanel.vue  # 系统设置
│   └── viewer/            # 3D/Live2D 渲染器
├── stores/
│   ├── auth.ts            # 访客用户状态
│   ├── agents.ts          # Agent 列表
│   ├── chat.ts            # 会话/消息/未读
│   ├── compute.ts         # 算力平台 Provider
│   └── ui.ts              # UI 状态
├── composables/
│   └── useWebSocket.ts    # WebSocket 封装
├── router/
│   └── index.ts           # 路由定义
└── views/
    ├── AppShell.vue       # 主布局
    └── HomeView.vue       # 首页
```

### 7.2 状态管理 (Pinia)

| Store | 职责 |
|-------|------|
| `auth` | 访客用户信息（固定 guest） |
| `agents` | Agent 列表、创建、编辑 |
| `chat` | 会话列表、消息、未读红点、当前会话 |
| `compute` | 算力平台 Provider 列表、增删改 |
| `ui` | 侧边栏展开、主题、加载状态 |

### 7.3 消息渲染

前端解析消息中的特殊标记：
- `[image:url]` → 内联图片
- `[file:url]` → 下载链接
- `content_type === 'image'` → 图片消息
- `content_type === 'mixed'` → 图文混排

**Agent 回复气泡合并**：同一 `batch_id` 的消息合并为一个气泡：
- 顶部：`reasoning` 折叠栏（"已思考 N 字"）
- 中部：`tool_calls` 标签栏（可展开查看参数）
- 底部：`content` 正文内容（Markdown 渲染，含代码高亮、表格、引用）

> Markdown 渲染使用 `marked` + `DOMPurify`，生成中保持纯文本 typing 效果，完成后渲染 HTML。

**智能滚动**：
- 用户主动上滑时，自动暂停滚动
- 新消息到达显示 "↓ 新消息" 浮动按钮
- 用户滑到底部时自动恢复自动滚动

---

## 8. 错误处理与恢复

### 8.1 错误分类

| 类型 | 示例 | 策略 |
|------|------|------|
| 可重试 | RateLimit, Timeout | 指数退避重试（最多 3 次） |
| 可降级 | API 故障, 认证失败 | 切换 fallback provider |
| 不可恢复 | 模型不支持, 参数错误 | 直接报错 |

### 8.2 Provider 降级链

配置项：`config.provider.fallback_chain`

```
默认: deepseek → mimo → kimicode → glm

LLM 调用失败时:
  1. 判断错误类型（classify_error）
  2. 可重试 → 指数退避重试
  3. 不可重试 → 切换 fallback provider
  4. 全部失败 → 返回错误给前端
```

### 8.3 SmartStop

防止 Agent 陷入无限循环：
- `max_turns` — 最大轮数（默认 50）
- `max_tokens` — 最大 token 数（默认 200K）
- `timeout_seconds` — 超时（默认 600s）
- `no_progress_rounds` — 无进展轮数（默认 3）
- `loop_detect_rounds` — 循环检测（默认 2）

---

## 9. 配置系统

单一真相源：`backend/engine/config.yaml`

```yaml
provider:
  default: glm
  fallback_chain: [glm, kimicode]
  deepseek: { base_url: ..., model: ..., api_key: ... }
  glm: { base_url: ..., model: ..., api_key: ... }

assistant_model: { base_url: ..., model: ..., api_key: ... }
embedding_model: { base_url: ..., model: ..., api_key: ... }

agent:
  max_turns: 50
  memory_system: topic_compression  # simple | topic_compression
  smart_stop: { max_turns: 50, max_tokens: 200000, ... }

context:
  max_context_tokens: 128000
  semantic_search_top_k: 10
  semantic_score_threshold: 0.3
  hot_context_initial: 20
  time_decay_half_life_hours: 72.0

tools:
  toolsets: [web, file, code]
  max_result_chars: 12000
```

---

## 10. 数据流详细时序

### 10.1 私聊完整链路

```
User        Frontend    WS        Platform    EngineBridge    AgentWorker    ReActAgent    LLM API
 │             │         │            │              │              │              │           │
 │──input───▶│         │            │              │              │              │           │
 │             │──WS───▶│            │              │              │              │           │
 │             │        │──save msg─▶│              │              │              │           │
 │             │        │            │──Job────────▶│              │              │           │
 │             │        │            │              │──enqueue───▶ │              │           │
 │             │        │            │              │              │──Job───────▶ │           │
 │             │        │            │              │              │              │──Context──│
 │             │        │            │              │              │              │ Pipeline  │
 │             │        │            │              │              │              │──stream──▶│
 │             │◀──WS───│◀───────────│◀─────────────│◀─────────────│◀──chunk─────│           │
 │◀─render───│         │            │              │              │              │           │
 │             │        │            │              │              │              │◀──done───│
 │             │        │            │              │              │              │──persist─▶│
 │             │        │            │              │              │              │ (session  │
 │             │        │            │              │              │              │  store)   │
```

### 10.2 群聊完整链路

```
User        Frontend    WS        Platform        GroupChatRouter    EngineBridge    ...
 │             │         │            │                   │                │
 │──input───▶│         │            │                   │                │
 │             │──WS───▶│            │                   │                │
 │             │        │──save msg─▶│                   │                │
 │             │        │            │──route()─────────▶│                │
 │             │        │            │                   │──for each─────▶│
 │             │        │            │                   │  selected      │──▶ AgentWorker x N
 │             │◀──WS───│◀───────────│◀──────────────────│◀───────────────│◀── chunks
 │◀─render───│         │            │                   │                │
 │             │        │            │                   │──sync memory──▶│ (other agents)
```

---

## 11. 性能与安全

### 11.1 已知性能瓶颈

| 瓶颈 | 原因 | 方案 |
|------|------|------|
| Agent 首次回复慢 | Worker 冷启动（查 DB + 建 Transport） | Worker 预启动或连接池 |
| 群聊多 Agent 并行 | N 个 Agent 同时查 DB、调 LLM | 并发控制 3 个 |
| 图片 base64 传输 | 大图片导致 WS 帧过大 | 限制 5MB，图片 CDN |
| 向量检索 | zvec 本地文件，大数据量时 | 迁移 Milvus/Pinecone |
| 算力配置双轨 | `llmprovider/*.json` 与 `ComputeProvider` 表并存（JSON 已废弃） | 逐步清理 registry.py 的 JSON 依赖 |

### 11.3 已知限制

| 限制 | 现状 | 建议 |
|------|------|------|
| 前端 systemLogs 无持久化 | `frontend/src/composables/useWebSocket.ts:24` 为内存数组 `ref<LogEntry[]>([])`，无 localStorage 或后端持久化 | 如需持久化，建议写入 localStorage 或后端 |

### 11.2 安全模型

| 风险 | 现状 | 建议 |
|------|------|------|
| 文件系统逃逸 | `write_file` 有路径白名单 | 增加 chroot 或沙箱 |
| 代码执行 | `python_execute` / `shell_command` | 增加确认弹窗或禁用开关 |
| API Key 泄露 | 存在 config.yaml | 支持环境变量覆盖 `${ENV_VAR}` |
| WS 无鉴权 | 任意客户端可连接 | 增加简单 token（即使 guest 也验证） |
| SQLite 并发 | WAL 模式但单进程 | 生产环境迁移 PostgreSQL |
