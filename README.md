# CloudMind-Zome

> 多 Agent 协作调度平台 —— 让每一个数字心智拥有完整的生命周期。

CloudMind-Zome 是一个面向未来的多 Agent 协作平台。它将多个独立 Agent（心智）整合到统一的调度与通讯框架中，支持私聊、群聊、任务编排、记忆管理与跨场景协作。

---

## 功能特性

- **心智管理** —— 创建、配置、形象化展示 Agent（立绘 / Live2D / 3D VRM）
- **私聊系统** —— 与单个 Agent 一对一对话，实时流式回复，支持图片发送
- **群聊系统** —— 多 Agent 群组讨论，支持 `@mention` 指定回复对象、@所有人
- **队长机制** —— 群聊可任命 Conductor（队长），负责话题引导与 Q&A
- **心智互聊** —— 开启后 Agent 之间可自动对话，形成思维碰撞
- **蓝图工作流** —— 可视化节点编辑器编排复杂任务流程，支持审批节点
- **任务调度** —— Cron / Interval / 手动触发，Agent 主动执行计划（Commission）
- **审批系统** —— 敏感操作需人工审批后方可执行
- **全局记忆** —— 跨场景统一记忆池，支持语义检索与自动话题压缩
- **语义搜索** —— 基于 zvec（C++ HNSW）的向量记忆检索，跨场景召回
- **智能停止** —— SmartStop 检测死循环、无进展、超时，自动终止
- **错误恢复** —— Provider 降级链 + 指数退避重试

---

## 技术栈

| 层级 | 技术 |
|---|---|
| 后端 | Python 3.11+, FastAPI, SQLAlchemy 2.0 (async), SQLite + WAL |
| 前端 | Vue 3, Vite, Pinia, TypeScript |
| 实时通信 | WebSocket (单连接多协议) |
| 向量存储 | zvec (C++ HNSW，替代 ChromaDB) |
| LLM 客户端 | OpenAI SDK (兼容 DeepSeek / MiMo / KimiCode / GLM) |
| 进程管理 | Python asyncio + 全局 Agent Worker |
| 桌面封装 | Tauri (Rust) |

---

## 快速启动

### 环境要求

- Python 3.11+
- Node.js 18+
- Windows / Linux / macOS

### 1. 克隆仓库

```bash
git clone https://github.com/yourname/MindCloud-Zome.git
cd MindCloud-Zome
```

### 2. 配置后端

```bash
cd backend
# 编辑 engine/config.yaml，填入你的 API Key
```

需要配置的 Key：
- `provider.deepseek.api_key` —— LLM 主 provider
- `tavily.api_key` —— 网络搜索工具
- `assistant_model.api_key` —— 记忆压缩助手模型（可选）
- `embedding_model` —— 语义向量模型（可选，用于 zvec 语义检索）

### 3. 安装依赖

```bash
# 后端
pip install -r requirements.txt

# 前端
cd ../frontend
npm install
```

### 4. 启动开发环境

在项目根目录执行：

```bash
# Windows (Web 模式，浏览器访问)
start-dev.bat

# Windows (Tauri 桌面模式，WebView2 窗口)
start-tauri.bat

# 或 PowerShell
powershell -ExecutionPolicy Bypass -File start-dev.ps1
```

服务启动后：
- 前端：`http://localhost:1420`
- 后端 API：`http://127.0.0.1:8848`
- WebSocket：`ws://127.0.0.1:8848/api/v1/ws`

---

## 项目结构

```
MindCloud-Zome/
├── backend/
│   ├── app/                 # FastAPI 平台层
│   │   ├── api/             # REST + WebSocket API
│   │   ├── models/          # SQLAlchemy 数据模型
│   │   ├── services/        # 业务服务（Worker、调度器、事件总线）
│   │   └── main.py          # 应用入口
│   ├── engine/              # Agent 引擎层（ReAct 循环、工具、记忆）
│   │   ├── agent/           # ReActAgent 核心循环
│   │   ├── context/         # ContextPipeline + zvec 向量存储 + Embedder
│   │   ├── memory/          # MemorySystem 插件体系 + TopicCompressionMemory
│   │   ├── provider/        # LLM Transport + Thinking Profile + Factory
│   │   ├── tool/            # 工具注册中心
│   │   ├── tools/           # 工具实现（搜索、代码、文件、通讯）
│   │   ├── message/         # 消息类型定义
│   │   ├── session/         # SQLite 持久化存储
│   │   ├── config/          # 配置加载（Pydantic）
│   │   └── error/           # 错误分类与重试
│   └── requirements.txt
├── frontend/
│   └── src/
│       ├── components/      # Vue 组件（ChatView、GroupChatView、BlueprintCanvas 等）
│       ├── stores/          # Pinia 状态管理
│       ├── api/             # 统一 API 客户端
│       ├── views/           # 页面视图
│       └── composables/     # WebSocket 封装
├── docs/                    # 设计文档
├── start-dev.bat            # 一键 Web 开发启动
├── start-tauri.bat          # 一键 Tauri 桌面启动
└── start-dev.ps1            # PowerShell 版启动脚本
```

---

## 核心架构

### Agent = 单一数字生命

- 每个 Agent 拥有**唯一的全局 Worker**（`AgentWorker`）
- 单一 `ReActAgent` 实例，永不重建，持有场景隔离的记忆 `_messages`
- FIFO 任务队列，所有 Job（私聊、群聊、任务）按顺序处理
- 空闲 5 分钟后自动进入内省（`TopicCompressionMemory.check_compression()`）

### Context Pipeline（上下文组装）

每轮 LLM 调用前，`ContextPipeline` 按以下顺序组装 prompt：

| 层级 | 内容 | 优先级 | 降级策略 |
|------|------|--------|----------|
| L1 | Mind 文件（SOUL.md / AGENT.md / USER.md） | 最高 | 不降级 |
| L2 | 场景信息（当前场景名 + 发送者） | 最高 | 不降级 |
| L3 | Hot Context（当前场景最近 N 条消息） | 高 | 从最老开始去掉：20→15→10→5 |
| L4 | 语义检索结果（zvec 跨场景 top-K） | 中 | 从低分开始去掉：10→5→3→0 |
| L5 | 话题摘要（`_compressed/*.md` 压缩历史） | 低 | 多条合并成一条概要 |
| L6 | 工具描述 | 最高 | 不降级 |

**降级顺序：L5 → L4 → L3**，超限时自动触发，L1/L2/L6 永不动。

### 记忆系统

**三层架构：**

| 层级 | 来源 | 用途 |
|---|---|---|
| Hot Context | `_messages`（内存，按 `source_id` 隔离） | 当前对话上下文 |
| Semantic Memory | zvec 向量检索（跨场景） | 按语义相似度召回全场景历史 |
| Topic Summaries | `_compressed/*.md`（自动压缩） | 长期话题摘要，按修改时间排序 |

**话题压缩触发：**
- 上下文 token 数超过阈值（默认 80%）
- Agent 空闲超过 5 分钟且消息数 > 10（内省）
- `TopicMarker` 检测到话题切换时，异步 `CompressionWorker` 执行压缩

### 通信协议

- **单 WebSocket 连接**：所有实时流量走同一个 WS 通道
- **消息帧类型**：
  - `chat.message` — 消息内容
  - `chat.thinking` — 推理块（折叠显示）
  - `chat.tool_call` — 工具调用（折叠显示）
  - `chat.typing` — 输入状态
  - `agent.status` — Agent 状态变更（idle / busy / introspecting）
  - `intermind.start/end` — 心智互聊触发
  - `action.progress` — 工作流进度
  - `notification.new` — 系统通知

### 错误恢复

- **Provider 降级链**：`deepseek → mimo → kimicode → glm`，API 故障时自动切换
- **指数退避重试**：可恢复错误（RateLimit / Timeout）自动重试 3 次
- **LLM 流式中断**：流式响应失败时，fallback 到完整响应模式

---

## 开发说明

### 登录/注册（开发模式）

当前为开发便利，未登录用户自动回退为 Guest 用户，无需注册即可使用全部功能。

### 数据库

- 位置：`~/.cloudmind-zome/cloudmind.db`（SQLite，WAL 模式）
- 平台表（`chat_sessions`、`agents`、`users` 等）与引擎表（`agent_messages`、`llm_messages` 等）共存于同一文件
- 向量存储：`~/.cloudmind-zome/zvec/`（zvec 本地文件）

### Agent 数据目录

每个 Agent 的数据存储在：
- `~/.cloudmind-zome/agents/{agent_id}/`
  - `SOUL.md` — 灵魂内核 / 人格定义
  - `AGENT.md` — 工作规范 / 行为指南
  - `USER.md` — Agent 对用户的感知
  - `_compressed/*.md` — 话题压缩摘要
  - `memory.db` — 话题上下文状态

### 上传文件

- 存储位置：`~/.cloudmind-zome/uploads/`
- 通过 `/uploads/` 静态路径访问

---

## 路线图

- [x] 私聊 / 群聊系统
- [x] Agent 全局 Worker + 任务调度
- [x] 蓝图工作流（节点编辑器）
- [x] 语义记忆（zvec 向量检索）
- [x] `@mention` 心智提及 + @所有人
- [x] Context Pipeline（场景隔离 + 跨场景检索 + 降级）
- [x] Topic Compression Memory（自动话题压缩）
- [x] 真流式逐字输出
- [x] 消息合并（单气泡 reasoning + tools + content）
- [ ] 亲密度系统（Intimacy）
- [ ] 代称系统（Alias routing）
- [ ] Skill 系统
- [ ] MCP / ACP 管理
- [ ] 部署文档与 Docker 支持

---

## 许可证

GNU General Public License v3.0 (GPL-3.0)
