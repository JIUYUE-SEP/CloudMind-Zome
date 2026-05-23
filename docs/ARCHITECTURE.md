# CloudMind-Zome 架构文档

> Version: 1.0 | Date: 2026-05-23 | Branch: dev

---

## 1. 项目概述

CloudMind-Zome 是一个多 Agent 协作平台，核心设计理念是**"每个 Agent 是一个独立的数字生命"**。用户可以与单个 Agent 私聊，也可以创建群聊让多个 Agent 协作讨论。Agent 具备完整的记忆系统、工具调用能力、主动性（定时任务/亲密度唤醒），以及视觉感知能力（图像理解/生成）。

### 1.1 核心特性

| 特性 | 说明 |
|------|------|
| **私聊** | 用户与单个 Agent 一对一对话 |
| **群聊** | 多 Agent 协作，支持队长(Conductor)机制 |
| **工具调用** | Agent 可调用心智工具（搜索、文件操作、代码执行、生图等） |
| **记忆系统** | 分层语义记忆（语义/温热/冷），支持自动压缩 |
| **主动性** | Commission（定时任务）+ 亲密度唤醒 |
| **视觉能力** | 用户发图 Agent 可识图；Agent 可生图分享 |
| **无登录** | 纯访客模式，零门槛使用 |

---

## 2. 技术栈

### 2.1 后端

| 层级 | 技术 |
|------|------|
| 框架 | FastAPI + Uvicorn |
| ORM | SQLAlchemy 2.0 (async) |
| 数据库 | SQLite (`~/.cloudmind-zome/cloudmind.db`, WAL 模式) |
| 向量存储 | ChromaDB (`~/.cloudmind-zome/vectors/`) |
| LLM 客户端 | OpenAI SDK (兼容 DeepSeek/SiliconFlow 等) |
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
│   ├── agent/             # ReActAgent 核心循环
│   ├── provider/          # LLM Transport + Thinking Profile
│   ├── tool/              # 工具注册中心
│   ├── tools/             # 工具实现
│   ├── context/           # 语义记忆/向量存储
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
│  - ProactiveWake       (亲密度唤醒调度)                      │
│  - EventBus            (全局状态广播)                        │
└────────────────────────────┬────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│  Agent Engine                                               │
│  - ReActAgent          (ReAct 循环 + 统一记忆池)             │
│  - ChatCompletionsTransport  (OpenAI API 调用)              │
│  - ToolRegistry        (工具注册/发现/执行)                  │
│  - ContextManager      (语义记忆 + 自动压缩)                 │
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
| `agent_messages` | Agent 引擎层统一记忆池 |
| `llm_sessions` | 引擎层会话统计 |
| `llm_messages` | 引擎层消息（与 agent_messages 互补） |
| `llm_topics` | 话题摘要（压缩后） |
| `actions` / `action_runs` | 工作流蓝图与执行记录 |
| `commissions` / `commission_logs` | 定时任务与执行日志 |
| `compute_providers` | LLM 算力提供商配置 |
| `approvals` | 审批检查点 |
| `agent_user_relations` | 亲密度系统 |

### 4.2 关键关系

```
User (1) ───< Agent (N)
           │
           └──< ChatSession (N, via ChatSessionMember)

ChatSession (1) ───< ChatMessage (N)
                 ───< ChatSessionMember (N)

Agent (1) ───< agent_messages (N, 统一记忆池)
```

---

## 5. Agent 架构详解

### 5.1 Agent = 单一数字生命

每个 Agent 对应全局唯一的 `AgentWorker`：

- **一个 asyncio.Task** — 串行处理所有 Jobs
- **一个 asyncio.Queue** — FIFO 队列，不区分优先级
- **一个 ReActAgent 实例** — 永不重建，持有统一记忆池 `_messages`
- **一个状态** — idle / busy / introspecting，由 Worker 单点维护

```python
# AgentWorker 核心循环
async def run(self):
    while self._running:
        job = await self.queue.get()   # FIFO
        await self._execute_job(job)   # 串行执行
```

### 5.2 ReAct 循环

```
用户消息 → 加入 _messages → 构建 Prompt → LLM 调用 → 解析响应
                                                    ↓
                                          ┌─────────┴─────────┐
                                          ↓                   ↓
                                    [普通回复]           [Tool Calls]
                                          ↓                   ↓
                                    保存并结束          执行工具 → 结果加入 _messages
                                                            ↓
                                                    继续下一轮 LLM
```

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

### 5.4 记忆系统

**分层架构：**

```
┌─────────────────────────────────────────────┐
│  Hot Memory  (ReActAgent._messages)         │
│  - 最近 N 条消息，内存中直接访问              │
│  - 跨场景统一，所有 Job 共享                  │
├─────────────────────────────────────────────┤
│  Semantic Memory  (ChromaDB 向量)            │
│  - 每条消息自动 embedding                     │
│  - 按语义相似度检索                           │
├─────────────────────────────────────────────┤
│  Warm Memory  (llm_topics 摘要)              │
│  - 自动压缩后的话题摘要                       │
│  - 由 assistant_model 生成                   │
├─────────────────────────────────────────────┤
│  Cold Memory  (llm_topics high-importance)   │
│  - 跨 Agent 共享的高重要性主题                │
└─────────────────────────────────────────────┘
```

**压缩触发：**
- 上下文窗口达到阈值（默认 80%）
- Agent 空闲超过 5 分钟且消息数 > 10（内省）

### 5.5 工具系统

**10 个内置工具：**

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

**工具注册：** 使用 `@tool_registry.register()` 装饰器自动注册，支持从目录递归发现。

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
  ├──► chat.message     (消息)
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
│ - 语义意图路由       │
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

当 Agent A 在群聊中回复后，该交换（用户消息 + Agent A 回复）会被写入**所有其他 Agent** 的 `agent_messages` 表中，确保每个 Agent 都能看到群聊上下文。

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
| `ui` | 侧边栏展开、主题、加载状态 |

### 7.3 消息渲染

前端解析消息中的特殊标记：
- `[image:url]` → 内联图片
- `[file:url]` → 下载链接
- `content_type === 