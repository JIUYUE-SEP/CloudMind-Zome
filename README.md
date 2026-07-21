# CloudMind-Zome

> 多 Agent 协作调度平台。每个 Agent 是独立运行的数字生命，拥有私有记忆、工具调用能力与任务执行能力。用户通过私聊与 Agent 交互，并可借助 Plan / Skill / Subagent 扩展其能力。

```
私聊:    用户 ↔ Agent A
Plan:    目标 → 步骤 → 执行 → 暂停/恢复/重试
Subagent: 前台/后台借用其他 Agent 执行子任务
```

---

## 使用场景

**研究助手**
> 创建一个 Agent，给它文件和 Shell 工具，设置一个定时任务。它会定期把整理好的资料写成 Markdown 存入工作区，等你上线时汇报。

**代码协作**
> 在会话中切换到 code 模式，Agent 可读取项目文件、执行命令、精确编辑代码（写入操作需人工审批）。

**多角色写作**
> 创建三个 Agent：大纲规划、正文撰写、编辑校对。使用 Plan 编排步骤，每个 Agent 只记得自己的角色和上下文。

---

## 功能

- **私聊** — 与单个 Agent 一对一对话，WebSocket 流式输出（正文 / 思考 / 工具调用分帧推送）
- **群聊** — 多 Agent 会话，@mention 路由（`@all` / `@所有人` 广播，无 @ 时全员回复）
- **Agent 管理** — 创建、编辑、删除 Agent（基本资料 / 人设 / 模型 / Skill / 工具 / 外观）
- **工具调用** — ReActLoop 调用 7 个内置工具：read_file / write_file / edit_file / list_files / bash / run_command / dispatch_subagent；写类工具需人工审批
- **上下文管线** — ContextPipeline L1–L6 分层组装，tiktoken 真实计数，超预算按 L5 → L4 → L6-ext → L3 自动降级
- **长期记忆** — per-Agent JSON/JSONL 文档存储（原子写）
- **向量记忆** — 经 Rust sidecar（HNSW）的跨会话语义检索，需配置 embedder 并运行 sidecar（桌面端自动启动，不可用时静默降级）
- **Skill 系统** — 基于 SKILL.md 的技能加载（内置目录 / 全局目录 / Agent 私有目录），内容注入 system prompt
- **Plan / Subagent** — 计划管理（REST，内存态）与 `dispatch_subagent` 工具（前台/后台借用其他 Agent）
- **定时任务** — Cron 调度，到点自动给 Agent 派发任务
- **算力平台** — LLM Provider 管理（API Key AES-256-GCM 加密存储、baseUrl SSRF 校验、连接测试、用量统计）
- **蓝图工作流** — start / llm / tool / end 节点编排（线性链）
- **会话模式** — chat / code 双模式，code 模式下工具可访问项目目录
- **桌面应用** — Tauri 启动 Rust sidecar，sidecar 守护 Node 引擎（失败自动重启）

> 规划中：Intermind（心智互聊）、蓝图分支/并行/审批、公共 Skill 池、web_search / generate_image 工具、MCP、多用户
> 完整功能状态见 [`docs/路线图.md`](docs/路线图.md)

---

## 快速开始

### 环境

- Node.js 22+
- Rust（版本见 `rust-toolchain.toml`，当前 1.88）
- protoc 27+

### 1. 克隆

```bash
git clone https://github.com/yourname/MindCloud-Zome.git
cd MindCloud-Zome
```

### 2. 安装依赖

```bash
pnpm install
```

### 3. 启动开发

```bash
# 同时启动 engine + web
pnpm dev
```

- 前端：`http://localhost:3000`
- 后端 API：`http://127.0.0.1:8848`（Swagger UI：`http://127.0.0.1:8848/docs`）

### 4. 启动桌面

```bash
pnpm --filter @mindcloud/desktop dev
```

---

## 核心概念

### Agent = 独立数字生命

每个 Agent 拥有：
- **私有记忆** — per-Agent JSON/JSONL 文档存储
- **独立配置** — 自己的模型、人设、Skill、工具
- **工具权限** — 可调用文件、Shell、子代理等内置工具，写操作需人工审批
- **Plan 执行** — 通过 Plan 系统编排多步骤任务
- **Skill 扩展** — 基于 SKILL.md manifest 动态加载能力

### ReAct 循环

每轮对话中，引擎先经 ContextPipeline 组装上下文，再由 ReActLoop 决定：
- 直接回复用户
- 调用一个或多个工具
- 创建/更新 Plan 或 Subagent

### 单用户本地模式

- 无登录注册，开箱即用
- 所有数据存储在本地默认目录 `~/.cloudmind-zome`
- 可通过环境变量 `CLOUDMIND_DATA_DIR` 覆盖默认路径
- 可作为 Web 应用或 Tauri 桌面应用运行

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 后端引擎 | Node.js + TypeScript + Fastify 5 |
| 前端 | Nuxt 3 + Vue 3 + Pinia + TypeScript |
| 桌面 | Tauri 2 + Rust + WebView2 |
| 性能侧车 | Rust（zome-sidecar）+ gRPC（HNSW 向量搜索；另有 tokenizer / 加密 / 进程守护能力） |
| 存储 | per-Agent JSON/JSONL 文档存储（无数据库） |
| 包管理 | pnpm workspace + Turborepo |

---

## 常用命令

```bash
pnpm dev              # 启动 engine + web 开发服务
pnpm build            # 构建所有包
pnpm test             # 运行所有测试
pnpm typecheck        # 类型检查
pnpm lint             # 代码检查
pnpm test:e2e         # Playwright 端到端测试（自动启动 engine + web）

# 单独操作
pnpm --filter @mindcloud/engine test
pnpm --filter @mindcloud/web test
pnpm --filter @mindcloud/desktop dev
```

---

## 文档

| 文档 | 内容 |
|------|------|
| [`docs/开发指南.md`](docs/开发指南.md) | 本地开发、调试技巧、常见任务、提交前检查清单 |
| [`docs/API.md`](docs/API.md) | Engine REST 与 WebSocket API 说明 |
| [`docs/DEPLOY.md`](docs/DEPLOY.md) | 桌面与 Web 部署指南 |
| [`docs/架构文档.md`](docs/架构文档.md) | 分层架构、核心机制、数据流、配置系统、安全模型 |
| [`docs/路线图.md`](docs/路线图.md) | 功能状态：已实现 / 部分实现 / 规划中 / 已废弃 |

---

## 项目结构

```
MindCloud-Zome/
├── apps/
│   ├── desktop/       # Tauri 桌面应用
│   └── web/           # Nuxt 3 前端
├── services/
│   └── engine/        # Node.js 引擎（Fastify + ReAct + Tool System）
├── crates/
│   └── zome-sidecar/  # Rust 性能侧车（gRPC）
├── packages/
│   ├── shared/        # 共享 TypeScript 类型
│   └── skills/        # 内置 Skill
├── docs/              # 项目文档
└── scripts/           # 构建辅助脚本
```

---

## 数据存储

所有运行时数据本地存储，默认路径：`~/.cloudmind-zome`（Windows 上为 `%USERPROFILE%\.cloudmind-zome`）

可通过环境变量 `CLOUDMIND_DATA_DIR` 覆盖。

```
~/.cloudmind-zome/
├── config.json            # 全局配置（Provider、记忆参数；凭据加密落盘）
├── .master-key            # 自动生成的 AES 主密钥
├── blueprints.jsonl       # 蓝图定义
├── skills/                # 全局 Skill 目录
└── agents/{agentId}/      # 每个 Agent 的私有工作区
    ├── agent.json         # Agent 配置
    ├── messages.jsonl     # 会话消息
    ├── memories.jsonl     # 长期记忆
    ├── actions.jsonl      # 动作记录
    ├── llm_calls.jsonl    # LLM 调用记录
    ├── scheduler.jsonl    # 定时任务
    ├── files/             # 工具可读写目录
    ├── skills/            # Agent 私有 Skill
    └── indices/           # 向量索引（sidecar HNSW）
```

---

## 当前状态

核心功能可用，API 可能变动。详见 [`docs/路线图.md`](docs/路线图.md)。

---

## 许可证

GNU General Public License v3.0 (GPL-3.0)
