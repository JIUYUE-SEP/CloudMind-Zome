# CloudMind-Zome

> 多 Agent 协作调度平台 —— 让每一个数字心智拥有完整的生命周期。

CloudMind-Zome 是一个面向未来的多 Agent 协作平台。它将多个独立 Agent（心智）整合到统一的调度与通讯框架中，支持私聊、群聊、任务编排、记忆管理与跨场景协作。

---

## 功能特性

- **心智管理** —— 创建、配置、形象化展示 Agent（立绘 / Live2D / 3D VRM）
- **私聊系统** —— 与单个 Agent 一对一对话，实时流式回复
- **群聊系统** —— 多 Agent 群组讨论，支持 `@mention` 指定回复对象
- **队长机制** —— 群聊可任命 Conductor（队长），负责话题引导与 Q&A
- **心智互聊** —— 开启后 Agent 之间可自动对话，形成思维碰撞
- **蓝图工作流** —— 可视化节点编辑器编排复杂任务流程
- **任务调度** —— Cron / Interval / 手动触发，Agent 主动执行计划
- **审批系统** —— 敏感操作需人工审批后方可执行
- **全局记忆** —— 跨场景统一记忆池，支持语义检索与自动压缩
- **语义搜索** —— 基于 ChromaDB 的向量记忆检索

---

## 技术栈

| 层级 | 技术 |
|---|---|
| 后端 | Python 3.11+, FastAPI, SQLAlchemy 2.0 (async), SQLite + WAL |
| 前端 | Vue 3, Vite, Pinia, TypeScript |
| 实时通信 | WebSocket (单连接多协议) |
| 向量存储 | ChromaDB (语义记忆) |
| 进程管理 | Python asyncio + 全局 Agent Worker |

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
# 复制配置模板
cp engine/config.yaml.example engine/config.yaml
# 编辑 engine/config.yaml，填入你的 API Key
```

需要配置的 Key：
- `provider.deepseek.api_key` —— LLM 主 provider
- `tavily.api_key` —— 网络搜索工具
- `assistant_model.api_key` —— 记忆压缩助手模型（可选）
- `embedding_model` —— 语义向量模型（可选）

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
# Windows
start-dev.bat

# 或 PowerShell
powershell -ExecutionPolicy Bypass -File start-dev.ps1
```

服务启动后：
- 前端：`http://localhost:1420`
- 后端 API：`http://127.0.0.1:8848`

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
│   │   ├── context/         # 上下文管理 + 向量存储
│   │   ├── tools/           # 工具集（搜索、代码、文件、通讯）
│   │   └── config.yaml      # 引擎配置（需从 .example 复制）
│   └── requirements.txt
├── frontend/
│   ├── src/
│   │   ├── components/      # Vue 组件（ChatView、GroupChatView、BlueprintCanvas 等）
│   │   ├── stores/          # Pinia 状态管理
│   │   ├── api/             # 统一 API 客户端
│   │   └── views/           # 页面视图
│   └── package.json
├── docs/                    # 设计文档
└── start-dev.bat            # 一键开发启动脚本
```

---

## 核心架构

### Agent = 单一数字生命

- 每个 Agent 拥有**唯一的全局 Worker**
- 单一 ReActAgent 实例，统一记忆池
- FIFO 任务队列，所有 Job（私聊、群聊、任务）按顺序处理
- 空闲 5 分钟后自动进入内省（记忆压缩）

### 记忆层级

| 层级 | 来源 | 用途 |
|---|---|---|
| 语义记忆 | ChromaDB 向量检索 | 跨场景长期记忆 |
| 热记忆 | 最近 10 条消息 | 当前对话上下文 |
| 温记忆 | 近期话题摘要 | 短期跨会话关联 |
| 冷记忆 | 高重要性历史话题 | 全局背景知识 |

### 通信协议

- **单 WebSocket 连接**：所有实时流量走同一个 WS 通道
- **消息帧类型**：`chat.message`、`chat.typing`、`agent.status`、`intermind.start/end`、`action.progress`、`notification.new`

---

## 开发说明

### 登录/注册（开发模式）

当前为开发便利，未登录用户自动回退为 Guest 用户，无需注册即可使用全部功能。

### 数据库

- 位置：`~/.cloudmind-zome/cloudmind.db`（SQLite，WAL 模式）
- 平台表（chat_sessions、agents、users 等）与引擎表（agent_messages、llm_topics 等）共存于同一文件

### 上传文件

- 存储位置：`~/.cloudmind-zome/uploads/`
- 通过 `/uploads/` 静态路径访问

---

## 路线图

- [x] 私聊 / 群聊系统
- [x] Agent 全局 Worker + 任务调度
- [x] 蓝图工作流（节点编辑器）
- [x] 语义记忆（ChromaDB）
- [x] `@mention` 心智提及
- [ ] 话题树（V1.2）
- [ ] Skill 系统（V1.2）
- [ ] MCP / ACP 管理
- [ ] 部署文档与 Docker 支持

---

## 许可证

GNU General Public License v3.0 (GPL-3.0)
