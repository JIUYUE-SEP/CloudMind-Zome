# CloudMind-Zome

> 多 Agent 协作调度平台。每个 Agent 是独立运行的数字生命，拥有私有记忆、工具调用能力与任务执行能力。用户通过私聊与 Agent 交互，并可借助 Plan / Skill / Subagent 扩展其能力。

```
私聊:    用户 ↔ Agent A
Plan:    目标 → 步骤 → 执行 → 暂停/恢复/重试
Subagent: 前台/后台/Swarm 批量调度
```

---

## 使用场景

**研究助手**
> 创建一个 Agent，给它搜索和文件工具，设置一个 Plan。它会主动搜索行业动态，整理成 Markdown 存入工作区，等你上线时汇报。

**代码审查**
> 创建两个 Agent：一个写代码，一个审查。通过 Subagent 调度它们协作，写代码 Agent 提交文件后，审查 Agent 自动检查并指出问题。

**多角色写作**
> 创建三个 Agent：大纲规划、正文撰写、编辑校对。使用 Plan 编排步骤，每个 Agent 只记得自己的角色和上下文。

---

## 功能

- **私聊** — 与单个 Agent 一对一对话，流式输出
- **Agent 管理** — 创建、编辑、删除 Agent
- **工具调用** — ReActLoop 调用内置工具
- **长期记忆** — per-Agent JSON/JSONL 文档存储
- **Skill 系统** — 基于 SKILL.md manifest 的技能加载
- **Plan / Goal** — 计划管理、步骤执行、暂停/恢复/重试
- **Subagent** — 前台/后台/Swarm 批量调度
- **桌面应用** — Tauri 启动 Rust sidecar，sidecar 启动 Node 引擎

> 规划中：群聊、Intermind、Scheduler、ComputeCenter、蓝图工作流、系统设置、用户档案（Phase 9）
> 完整功能列表见 [`docs/路线图.md`](docs/路线图.md)

---

## 快速开始

### 环境

- Node.js 22+
- Rust 1.80+
- protoc

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
- **工具权限** — 可调用文件、搜索、代码执行等内置工具
- **Plan 执行** — 通过 Plan 系统编排多步骤任务
- **Skill 扩展** — 基于 SKILL.md manifest 动态加载能力

### ReAct 循环

每轮对话中，引擎通过 ReActLoop 决定：
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
| 性能侧车 | Rust（zome-sidecar）+ gRPC（向量搜索、token 计数、AES 加密） |
| 存储 | per-Agent JSON/JSONL 文档存储 |
| 包管理 | pnpm workspace + Turborepo |

---

## 常用命令

```bash
pnpm dev              # 启动 engine + web 开发服务
pnpm build            # 构建所有包
pnpm test             # 运行所有测试
pnpm typecheck        # 类型检查
pnpm lint             # 代码检查

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
├── docs/              # 架构文档
└── scripts/           # 构建辅助脚本
```

---

## 数据存储

所有运行时数据本地存储，默认路径：`~/.cloudmind-zome`（Windows 上为 `%USERPROFILE%\.cloudmind-zome`）

可通过环境变量 `CLOUDMIND_DATA_DIR` 覆盖。

```
~/.cloudmind-zome/
├── agents/            # Agent 配置与消息记录
├── memory/            # Agent 记忆文档
├── skills/            # Skill 配置
├── tools/             # 工具配置
├── downloads/         # 下载文件
└── ...
```

---

## 当前状态

核心功能可用，API 可能变动。详见 [`docs/路线图.md`](docs/路线图.md)。

---

## 许可证

GNU General Public License v3.0 (GPL-3.0)
