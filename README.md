# CloudMind-Zome

> 多 Agent 协作调度平台。每个 Agent 是独立运行的数字生命，拥有私有记忆、工具调用能力与主动任务调度。用户通过私聊或群聊与 Agent 交互，也可旁观 Agent 间自发的心智互聊。

```
私聊:    用户 ↔ Agent A
群聊:    用户 ↔ Agent A + Agent B + Agent C（@mention 路由）
互聊:    Agent A ↔ Agent B ↔ Agent C（Conductor 编排，用户旁观）
```

---

## 使用场景

**研究助手**
> 创建一个 Agent，给它搜索和文件工具，设置每天早上 9 点的 Commission。它会主动搜索行业动态，整理成 Markdown 存入工作区，等你上线时汇报。

**代码审查**
> 创建两个 Agent：一个写代码，一个审查。让它们进入群聊，写代码 Agent 提交文件后，审查 Agent 自动检查并指出问题。你旁观它们的讨论，只在关键决策时介入。

**多角色写作**
> 创建三个 Agent：大纲规划、正文撰写、编辑校对。在群聊中 @大纲规划 先出框架，@正文撰写 填充内容，@编辑校对 最后润色。每个 Agent 只记得自己的角色和对话上下文。

---

## 功能

- **私聊** — 与单个 Agent 一对一对话，流式输出，支持图片与引用回复
- **群聊** — 多 Agent 群组讨论，@mention 指定回复对象，Agent 自主决策是否参与
- **心智互聊** — Agent 间多轮讨论（Intermind），由队长编排，用户可旁观或中断
- **工具调用** — 搜索、文件操作、代码执行、生图、Agent 间私信等 10+ 工具
- **算力平台** — 管理 LLM Provider（API Key、Base URL、模型），支持 per-Agent 独立配置
- **全局记忆** — 跨场景语义检索（zvec）+ 话题自动压缩，Agent 长期记忆不丢失
- **任务调度** — Cron/Interval 定时任务，Agent 主动执行计划
- **蓝图工作流** — 可视化节点编排复杂任务，支持审批节点

> 完整功能列表见 [`docs/路线图.md`](docs/路线图.md)

---

## 快速开始

### 环境

- Python 3.11+
- Node.js 18+
- （可选）Rust 工具链 — 仅 Tauri 桌面模式需要

### 1. 克隆

```bash
git clone https://github.com/yourname/MindCloud-Zome.git
cd MindCloud-Zome
```

### 2. 配置

```bash
cd backend
cp engine/config.yaml.example engine/config.yaml
# 填入 Tavily API Key（用于搜索工具）
# 其他 Provider 通过前端「算力平台」界面配置
```

### 3. 安装依赖

```bash
pip install -r requirements.txt

cd ../frontend
npm install
```

### 4. 启动

```bash
cd ..          # 回到项目根目录

# Web 模式（浏览器访问）
start-dev.bat  # Windows

# Tauri 桌面模式（WebView2 窗口）
start-tauri.bat  # Windows，需要 Rust
```

启动后：
- 前端：`http://localhost:1420`
- 后端 API：`http://127.0.0.1:8848`

---

## 核心概念

### Agent = 独立数字生命

每个 Agent 拥有：
- **私有记忆** — 场景隔离的 `_messages` + 跨场景语义检索 + 话题压缩摘要
- **独立配置** — 自己的 LLM Provider、Embedder、生图模型、Fallback 链
- **工具权限** — 可调用搜索、文件操作、代码执行、向其他 Agent 发私信等工具
- **主动能力** — 通过 Commission 系统设置定时任务，Agent 主动执行
- **人格文件** — `SOUL.md`（灵魂内核）、`AGENT.md`（工作规范）、`USER.md`（用户感知）

### 上下文组装（Context Pipeline）

每轮 LLM 调用前，按 L1→L6 六层组装 prompt，超限时自动降级：

| 层级 | 内容 | 降级策略 |
|------|------|----------|
| L1 | Mind 文件（SOUL.md / AGENT.md / USER.md / PROFILE.md） | 不降级 |
| L2 | 群聊 sender 前缀 | 不降级 |
| L3 | Hot Context（当前场景最近 N 条消息） | 20→15→10→5 截断 |
| L4 | 语义检索结果（zvec 跨场景 top-K） | 10→5→3→0 从低分去掉 |
| L5 | 话题摘要（`_compressed/*.md`） | 多条合并成一条概要 |
| L6 | 工具描述 | 不降级 |

### 单用户本地模式

- 无登录注册，开箱即用
- 所有数据存储在本地 `~/.cloudmind-zome/`
- 可作为 Web 应用或 Tauri 桌面应用运行

---

## 技术栈

| 后端 | 前端 | 桌面 | 向量 |
|------|------|------|------|
| Python 3.11, FastAPI, SQLAlchemy 2.0 (async), SQLite + WAL | Vue 3, Vite 5, Pinia, TypeScript | Tauri 2 (Rust + WebView2) | zvec (C++ HNSW) |

---

## 文档

| 文档 | 内容 |
|------|------|
| [`docs/架构文档.md`](docs/架构文档.md) | 分层架构、核心机制、数据流、配置系统、安全模型 |
| [`docs/开发指南.md`](docs/开发指南.md) | 本地开发、调试技巧、常见任务、提交前检查清单 |
| [`docs/路线图.md`](docs/路线图.md) | 功能状态：已实现 / 部分实现 / 规划中 / 已废弃 |

---

## 项目结构

```
MindCloud-Zome/
├── backend/
│   ├── app/           # FastAPI 平台层（API、服务、模型）
│   ├── engine/        # Agent 引擎层（ReAct、ContextPipeline、工具）
│   └── run.py         # 开发启动入口
├── frontend/          # Vue 3 + Vite 前端
├── docs/              # 架构文档、开发指南、路线图
└── start-dev.bat      # 一键启动脚本
```

---

## 数据存储

所有运行时数据本地存储，默认路径：`~/.cloudmind-zome/`

```
~/.cloudmind-zome/
├── cloudmind.db          # SQLite 数据库
├── providers.yaml         # LLM Provider 配置（与 DB 双写）
├── userdata/profile.md    # 全局用户档案（所有 Agent 共享）
├── workspace/{agent_id}/  # Agent 工作区
│   ├── SOUL.md            # 灵魂内核
│   ├── AGENT.md           # 工作规范
│   ├── USER.md            # 用户感知（从 profile.md 复制后可独立编辑）
│   ├── PROFILE.md         # 对外资料
│   ├── IDENTITY.md        # 身份核心
│   ├── MEMORY.md          # 长期记忆
│   ├── HEARTBEAT.md       # 心跳任务
│   ├── _compressed/*.md   # 话题压缩摘要
│   └── skills/{name}/
│       └── SKILL.md       # 私有技能指令
├── uploads/               # 上传文件
└── zvec/                  # 向量库
```

---

## 为什么不是...

| 对比 | 差异 |
|------|------|
| **vs. 单一聊天机器人** | 不是问答工具，是多个独立 Agent 的协作环境 |
| **vs. 多轮对话应用** | Agent 有长期记忆、主动任务、工具调用，不只是对话 |
| **vs. 工作流编排器** | Agent 有自主决策能力，不是被动执行预设流程 |
| **vs. 云端 SaaS** | 本地优先，数据不出境，无账号体系 |

---

## 当前状态

核心功能可用，API 可能变动。详见 [`docs/路线图.md`](docs/路线图.md)。

---

## 许可证

GNU General Public License v3.0 (GPL-3.0)
