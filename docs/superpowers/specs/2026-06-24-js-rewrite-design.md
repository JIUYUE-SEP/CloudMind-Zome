# CloudMind-Zome JS/TypeScript 重构设计

## 1. 背景与目标

### 1.1 当前状态

CloudMind-Zome 原后端基于 Python（FastAPI + SQLAlchemy + 异步 SQLite），前端基于 Vue 3 + Vite + Tauri。项目当前正处于 **per-Agent 文档存储迁移** 的中期：Agent 配置、部分聊天消息和记忆数据已经迁到每个 Agent 独立的 JSON/JSONL 目录，但聊天、LLM 调用记录、任务等仍存在共享 SQLite 中。`ws_handlers.py`、`chat.py` 等核心文件因此充斥大量双轨分支，是最大技术债务来源。

### 1.2 重构原因

核心驱动力是**性能**：

- LLM 调用本身是网络延迟，Python/Node 差异不大。
- 向量检索已使用 C++ HNSW（zvec），不是 Python 瓶颈。
- 真正可优化的点在于：**JSON/JSONL 文件 I/O、同步序列化、复杂双轨分支带来的维护成本**。

Node.js 在 I/O 并发和 JSON 处理上优于 Python；TypeScript 在大型前端/后端统一代码库中更易于维护。

### 1.3 重构目标

- 用 **JavaScript/TypeScript** 完整重写 CloudMind-Zome。
- 保留并优化现有功能：私聊、群聊、Intermind、工具调用、算力平台、蓝图工作流、用户档案等。
- 引入 **Kimi Code CLI** 风格的 Agent 设计：Skill 系统、Subagent 分派、Plan/Goal 模式、统一工具协议。具体参考其开源实现（[MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code)，MIT License），包括无状态 ReAct loop、ToolScheduler、thinking/content 分离、子代理前台/后台/Swarm 模式等。
- 以 **性能** 为导向：Node.js 核心引擎 + Rust 性能侧车 + per-Agent 文档存储。
- 旧数据不保留，新数据全部走文档存储。
- 在 git 新分支 `refactor/js-rewrite` 上进行，原 `main` 保留 Python 项目作为参考。

### 1.4 关键策略决策

**直接开始 JS 重构，不再回 Python 完成文档存储迁移。**

原因：旧数据全部清除、已决定换技术栈、新分支从零开始没有历史包袱。Python 迁移中的经验和数据格式可以直接复用到 JS 设计，无需重复投入。

## 2. 约束与假设

- **单用户本地应用**：无登录注册，用户 ID 固定为 `"user"`。
- **本地优先**：数据默认存放在 `~/.cloudmind-zome/`。
- **桌面 + Web 双模式**：桌面模式用 Tauri；Web 模式直接启动 Node + Rust 侧车。
- **旧数据不迁移**：新架构不读取旧 SQLite 数据；首次启动新架构时，若检测到旧数据目录，提示用户备份后清空或迁移到新目录，避免脏读。
- **跨平台**：Windows（主要）、macOS、Linux 后续支持。
- **验收标准**：新架构能启动、完整功能可用、具备基础测试覆盖。

## 3. 技术栈

| 层级 | 技术 |
|------|------|
| 前端框架 | Nuxt 3 + Vue 3 + TypeScript |
| 前端状态 | Pinia |
| 前端 UI | 沿用原 Vue 组件并迁移到 Nuxt 约定 |
| 后端框架 | Node.js + TypeScript + Fastify |
| 实时通信 | WebSocket（原生 `ws` 库） |
| 进程间通信 | gRPC over Unix Domain Socket / Named Pipe（桌面）/ TCP（Web） |
| 桌面壳 | Tauri 2 + Rust |
| 性能侧车 | Rust |
| 数据存储 | per-Agent JSON/JSONL 文档存储 |
| 向量检索 | Rust HNSW（替换 zvec） |
| 包管理 | pnpm |
| Monorepo | pnpm workspace + Turborepo |
| 测试 | Vitest（Node/TS）、cargo test（Rust）、Playwright（E2E） |

## 4. 总体架构

运行时拆成 4 个角色：

1. **Tauri 主进程（Rust）**：负责桌面窗口、应用生命周期、启动 Rust 性能侧车。
2. **Nuxt 3 前端（TypeScript/Vue）**：负责所有 UI，通过 HTTP/WebSocket 与 Node 后端通信。启用 SSR。
3. **Node.js 核心引擎（TypeScript）**：独立进程，基于 Fastify 提供 REST/WebSocket；内含 Agent Worker、ReAct 循环、LLM Provider、工具系统、文档存储 Repository、Skill/Plan/Subagent 管理。
4. **Rust 性能侧车**：负责向量检索、token 计数、敏感配置加密、代码/Shell 轻量沙箱、进程守护（启动/监控 Node 后端）。

### 4.1 分层原则

- `engine` 层不依赖 `app` 层；Repository 接口隔离具体存储实现。
- 工具系统通过插件式注册；Skill 是可复用的工具+prompt 包。
- 性能敏感模块下沉到 Rust 侧车；业务编排保留在 Node.js 以利于快速迭代。

## 5. 目录结构

```
refactor/js-rewrite/
├── apps/
│   ├── desktop/              # Tauri 桌面壳
│   │   ├── src-tauri/        # Rust：窗口、sidecar 管理
│   │   └── package.json
│   └── web/                  # Nuxt 3 前端
│       ├── components/       # UI 组件
│       ├── pages/            # 页面路由
│       ├── stores/           # Pinia 状态
│       ├── server/           # Nitro API/代理
│       └── package.json
├── services/
│   └── engine/               # Node.js 核心引擎
│       ├── src/
│       │   ├── api/          # Fastify REST + WebSocket routes
│       │   ├── core/         # AgentWorker、ReActLoop、Conductor、Scheduler
│       │   ├── skills/       # Skill 注册与管理
│       │   ├── plan/         # Plan/Goal Manager
│       │   ├── subagent/     # Subagent Dispatcher
│       │   ├── memory/       # DocumentStore、Repository、向量查询客户端
│       │   ├── tools/        # Tool registry + 各 toolset 实现
│       │   ├── provider/     # LLM/Embedder/ImageGen Provider
│       │   ├── config/       # 路径、环境变量
│       │   └── bootstrap.ts  # 启动入口
│       └── tests/
├── crates/
│   └── zome-sidecar/         # Rust 性能侧车
│       ├── src/
│       └── Cargo.toml
├── packages/
│   ├── shared/               # 前后端共享类型、常量
│   │   └── src/
│   └── skills/               # 内置 Skill 包
│       └── src/
├── package.json
├── pnpm-workspace.yaml
└── turbo.json
```

## 6. 数据层设计

沿用 per-Agent 文档存储，每个 Agent 有独立目录：

```
~/.cloudmind-zome/agents/{agentId}/
├── agent.json           # Agent 配置（persona、model、skills、tools）
├── messages.jsonl       # 私聊消息（append-only）
├── llm_calls.jsonl      # LLM 调用记录
├── memories.jsonl       # 语义记忆条目
├── actions.jsonl        # 任务/Action 记录
├── topics/              # Topic 摘要 markdown
│   └── {topicId}.md
└── indices/             # Rust 侧车维护的索引文件
    └── hnsw/
```

### 6.1 Repository 抽象

- `IAgentRepository`：读写 `agent.json`。
- `IMessageRepository`：按 session 追加/查询消息；支持游标分页。
- `IMemoryRepository`：记忆 CRUD + 向量检索入口（实际计算转发 Rust 侧车）。
- `IActionRepository`：任务队列持久化 + 状态流转。
- `ILLMCallRepository`：LLM 调用记录追加与查询。

### 6.2 性能优化

- JSONL 使用流式写入 + 批量读取，避免一次性加载大文件。
- 每条记录包含自增 `localId` 和 UUID，支持快速定位。
- Rust 侧车异步构建 HNSW 索引；Node 通过 gRPC 调用 `search`/`upsert`。
- 常用配置（`agent.json`）在内存中缓存并监听文件变化。

## 7. 后端引擎核心

### 7.1 AgentWorker

每个 Agent 一个 `AgentWorker` 实例：

- 持有 FIFO 任务队列。
- 维护当前状态：`idle` / `busy` / `paused`。
- 持有独立 `ReActLoop` 实例。
- 接收用户消息、系统事件、其他 Agent 消息、定时任务。

### 7.2 ReActLoop（参考 Kimi Code CLI，MIT 许可）

采用**无状态核心循环 + 有状态宿主**的分层设计：

- **`runTurn`（Turn 级收敛循环）**：`while(true)` 反复调用单步执行，直到停止原因不是 `tool_use` 或达到 `maxSteps`。
- **`executeLoopStep`（单步循环）**：调用 LLM → 解析停止原因 → 若为 `tool_use` 则执行工具批次 → 派发 `step.end` 事件。
- **`TurnFlow` / `AgentWorker`（有状态宿主）**：注入 messages、tools、hooks、事件派发，维护会话上下文。

具体能力：

- **原生 Tool/Function Calling**：模型直接输出工具调用 JSON。
- **ToolScheduler 并行/串行调度**：根据工具访问的资源冲突决定并行或串行执行（见 7.11）。
- **Structured Output**：定义最终回复的 JSON Schema，强制模型输出。
- **Streaming**：`text.delta` 和 `thinking.delta` 分通道流式推送。
- **Thinking / Content 分离**：assistant message 的 `content` 数组同时包含 `TextPart` 和 `ThinkPart`；UI 可折叠显示 thinking，正式 text 到达后固化。
- **简单 Reflection**：执行完一轮后让模型自检，必要时重试或修正。

### 7.3 Conductor

多 Agent 场景编排：

- 群聊路由：支持 @mention、语义匹配、随机选择。
- Intermind 调度：编排 Agent 间自发心智对话。
- Agent 间私信转发。

### 7.4 Scheduler

- 基于 `cron-parser` 的定时任务。
- 优先级队列。
- 触发 Agent 主动行为。

### 7.5 Provider 层

统一接口：

- `LLMProvider`：支持 OpenAI、Anthropic、Ollama、OpenRouter 等，支持 fallback。
- `EmbedderProvider`：支持多种 embedding 模型。
- `ImageGenProvider`：支持 DALL-E、Stable Diffusion 等。

### 7.6 Tool System

- 每个 toolset 是独立模块（file、web、code、shell、comms、group、project）。
- 通过函数元数据注册 Schema；工具实现返回 `{ execute: (ctx) => ... }`。
- 工具可访问 `AgentContext`、`Workspace`、`MemoryClient`。
- 敏感操作（如 shell、文件删除）通过 Tool Protocol 触发用户审批。
- 工具声明自身访问的资源（文件路径、网络、进程等），供 ToolScheduler 做冲突调度。

### 7.7 Skill System

每个 Skill 是一个独立包（`packages/skills/{skill-name}/`）：

- `SKILL.md`：说明、使用场景、示例。
- `tools/`：该 Skill 提供的工具列表。
- `prompts/`：系统提示、任务模板。
- `schema.json`：配置 Schema。

Agent 运行时可加载多个 Skill，Skill 决定 Agent 能做什么。Engine 在启动时扫描 `packages/skills/` 和 `~/.cloudmind-zome/skills/` 目录，按 `SKILL.md` 元数据注册 Skill。

### 7.8 Subagent Dispatcher（参考 Kimi Code CLI，MIT 许可）

每个子代理是独立的 `Agent` 实例，拥有独立的 `ContextMemory`、tools、permission policies。

**借用机制**：

- 父 Agent 需要子任务时，从用户已创建的 Agent 中选择一个（或系统自动选）。
- 为子任务创建**隔离的运行时上下文**：复用该 Agent 的配置、模型、Skill、工具，但使用临时 memory overlay 和临时 workspace。
- 子代理继承父代理关键设置（`cwd`、`modelAlias`、`thinkingLevel`），但应用自己的 profile。
- 取消信号通过 `AbortSignal` 级联传播，用户中断父 Agent 时子代理一并停止。

**运行模式**：

- **前台模式**：父 Agent 等待子代理完成并获取结果。
- **后台模式**：子代理注册到 `BackgroundManager`，负责输出捕获、超时、取消、持久化；完成/失败通过 WebSocket 事件推送给前端，前端以通知形式提醒用户。
- **Swarm 模式**：通过 `SubagentBatch` 批量调度多个子代理，支持并发上限、provider 限流退避、重试、按输入顺序返回结果。

### 7.9 Plan/Goal Manager

- 用户给 Agent 设定 Goal 后，Agent 先做一次 "plan" 调用生成可执行步骤列表。
- Plan Manager 跟踪每一步状态：`pending` / `running` / `completed` / `failed` / `awaiting_approval`。
- 每一步可以映射为一次工具调用、一次子代理调用或一次 LLM 调用。
- 支持暂停、重试、人工审批；审批复用 Tool Execution Pipeline 的 Authorize Hook，审批通过后继续执行下一步。

### 7.10 Tool Protocol

统一工具调用协议包含：

- 工具描述与参数 Schema。
- 执行请求与结果。
- 审批请求（敏感操作）。
- 流式中间事件（开始、进度、完成、错误）。

### 7.11 Tool Execution Pipeline（参考 Kimi Code CLI，MIT 许可）

单次 LLM 返回多个 tool calls 时，按以下六阶段处理：

1. **Preflight**：校验工具存在、JSON 参数、Schema。
2. **Prepare Hook**：可拦截、替换参数或生成 synthetic result。
3. **Authorize Hook**：权限/审批层；敏感操作触发用户确认。
4. **Dispatch `tool.call` 事件**：按 provider 顺序记录到 transcript。
5. **Schedule & Execute**：`ToolScheduler` 根据工具声明的 `ToolAccesses` 冲突决定并行或串行，然后调用 `execute(ctx)`。
6. **Finalize Hook**：结果定型，派发 `tool.result` 事件，写回 `ContextMemory` 进入下一轮。

**ToolScheduler 规则**：

- 两个工具访问冲突资源（如同一文件、同一进程）则串行。
- 无冲突则通过 `Promise.all` 并行执行。
- 工具通过 `accesses` 声明自己读/写的资源路径和类型。

## 8. Rust 性能侧车

`crates/zome-sidecar/` 是独立 Rust 进程。

### 8.1 职责

- **向量检索**：基于 HNSW 实现 `upsert(id, embedding)` 和 `search(embedding, topK)`，替换原 Python 的 zvec。
- **Token 计数**：tiktoken 等价物，快速计算 prompt token。
- **敏感配置加密**：密钥派生、加密 Agent 敏感配置。
- **代码/Shell 轻量沙箱执行**：通过 seccomp/namespace/资源限制做中等隔离。
- **进程守护**：启动/监控 Node.js 核心引擎，崩溃时自动重启；Tauri 同时监控 Rust 侧车健康，形成双向守护。

### 8.2 通信

- 首选 **gRPC over Unix Domain Socket / Named Pipe（桌面）/ TCP（Web 模式）**。
- 备选 HTTP/2 JSON，便于调试。
- Node 端通过 `VectorSearchClient`、`TokenCounterClient`、`SandboxClient` 等封装调用。

### 8.3 索引持久化

- 索引文件写到 `~/.cloudmind-zome/agents/{agentId}/indices/hnsw/`。
- Rust 侧车启动时加载已有索引，运行中异步更新。

## 9. 前端 / Nuxt 3 设计

`apps/web/` 基于 Nuxt 3 + Vue 3 + TypeScript + Pinia，**启用 SSR**。

### 9.1 页面

- `pages/index.vue`：Home
- `pages/hub.vue`：CommunicationHub
- `pages/agents/[id].vue`：AgentEdit
- `pages/compute.vue`：ComputeCenter
- `pages/settings.vue`：SystemSettings

### 9.2 组件

- 尽量迁移原 `frontend/src/components/` 的组件。
- 按 Nuxt 约定放到 `components/`，启用自动导入。

### 9.3 状态管理

Pinia stores：

- `agents.ts`
- `chat.ts`
- `compute.ts`
- `settings.ts`
- `auth.ts`（单用户）

### 9.4 API 通信

- `composables/useEngineClient.ts` 封装 Node 后端的 HTTP/WebSocket 调用。
- Nitro server 只处理前端 SSR 和本地代理，不跑长任务。

### 9.5 SSR 策略

- **Web 模式**：启用 Nuxt SSR，Nitro server 处理首次渲染和本地 API 代理。
- **桌面模式**：Tauri 内使用 Nuxt SPA 模式，不依赖 Nitro server，前端直接通过 Tauri API 从 Rust 侧车获取 Node 后端地址。

## 10. Tauri 集成与启动流程

### 10.1 进程关系

- **Tauri 主进程**：负责窗口、生命周期、启动 Rust 侧车。
- **Rust 侧车**：被 Tauri 启动后，启动并监控 Node.js 核心引擎；同时提供性能服务。
- **Node.js 核心引擎**：被 Rust 侧车启动，处理业务逻辑。
- **Nuxt 前端**：在 Tauri 窗口中运行，连接 Node 后端。

### 10.2 启动顺序

1. Tauri 启动 Rust 侧车。
2. Rust 侧车启动 Node.js 核心引擎，并等待健康检查通过。
3. Tauri 加载 Nuxt 前端。
4. Nuxt 通过 Tauri 命令从 Rust 侧车获取 Node 后端地址，建立 HTTP/WebSocket 连接。

### 10.3 Web 模式

无 Tauri 时：

- 直接启动 Rust 侧车（监听 TCP 端口）。
- Rust 侧车启动 Node.js 核心引擎。
- Nuxt 以 SSR 模式运行，通过 Nitro server 代理到本地后端（默认 `http://127.0.0.1:8848`）。

### 10.4 优雅退出

Tauri 关闭 → 通知 Rust 侧车 → Rust 侧车通知 Node 保存状态 → 依次停止 Node、Rust 侧车，最后 Tauri 退出。

## 11. 测试策略

### 11.1 单元测试

- Node/TS：`vitest`
  - Repository（文档存储读写）
  - Provider（LLM/Embedder fallback）
  - Tool System
  - ReActLoop
  - Plan Manager
  - Subagent Dispatcher
- Rust：`cargo test`
  - HNSW 向量检索
  - Token 计数
  - 加密
  - 沙箱执行

### 11.2 集成测试

- Node 后端：`supertest` + 临时数据目录
  - REST API：Agent CRUD、消息发送、记忆写入
  - WebSocket：连接、消息收发、流式事件
- Rust 侧车：gRPC 客户端测试 `upsert`/`search`

### 11.3 E2E 测试

- `Playwright` 覆盖 Nuxt 前端 + Node 后端：
  - 创建 Agent
  - 发送消息
  - 验证回复
  - 验证工具审批流

### 11.4 覆盖率目标

- 引擎核心 ≥ 70%
- Repository、Provider、Tool 系统重点覆盖
- 前端核心组件 ≥ 50%

### 11.5 CI

GitHub Actions 执行 `lint → test → build`：

- Node/TS lint + test
- Rust fmt + clippy + test
- Nuxt build
- Tauri 生产构建只在发布 tag 推送时跑

## 12. 开发节奏

| 阶段 | 内容 |
|------|------|
| Phase 0 | 基础设施：创建分支，搭建 pnpm workspace + Turborepo，CI，共享类型包，lint |
| Phase 1 | Rust 侧车：HNSW、token 计数、加密、进程守护与沙箱骨架、gRPC 通信 |
| Phase 2 | Node 引擎核心：Repository、Provider、Tool System、ReActLoop、Plan/Goal、Subagent |
| Phase 3 | API 与 WebSocket：Fastify REST + WebSocket，暴露 Agent/Chat/Memory/Action/Skill 接口 |
| Phase 4 | Nuxt 前端：迁移核心页面和组件，实现实时通信 |
| Phase 5 | Tauri 集成：Rust 侧车启动 Node、Tauri 启动 Rust 侧车、优雅退出、桌面打包 |
| Phase 6 | 完整功能迁移：群聊、Intermind、Scheduler、ComputeCenter、蓝图工作流、系统设置 |
| Phase 7 | 测试与优化：补充测试、性能基准、文档、Tauri 生产构建 |

## 13. 验收标准

- [ ] `refactor/js-rewrite` 分支能正常启动：Node 后端 + Rust 侧车 + Nuxt 前端（Web 模式）。
- [ ] Tauri 桌面模式能打包并运行。
- [ ] 核心功能可用：Agent 管理、私聊、记忆、工具调用、Skill 加载。
- [ ] 完整功能可用：群聊、Intermind、Scheduler、ComputeCenter、蓝图工作流、系统设置、用户档案。
- [ ] 后端核心测试覆盖 ≥ 70%，关键模块有集成测试。
- [ ] 前端核心组件有单元测试，关键用户流程有 Playwright E2E 测试。
- [ ] CI 通过 `lint → test → build`。
