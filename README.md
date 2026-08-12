# CloudMind-Zome

> 数字生命/人形栖息地：每个 Agent 是独立运行的数字生命（人形），归属部署者本人、与其共同生活。单用户本地模式，所有数据留在本地，软件可分发（类 Obsidian 模式）；用户通过私聊与 Agent 交互，并可借助 Plan / Skill / Subagent 扩展其能力。

```
私聊:    用户 ↔ Agent A
Plan:    目标 → 步骤 → 执行 → 暂停/恢复/重试
Subagent: 前台/后台借用其他 Agent 执行子任务
```

每个 Agent 属于部署者本人，与其共同生活：私有记忆、工具与任务执行能力均留在本地；单用户本地运行，软件可整体分发。

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
- **群聊** — 多 Agent 会话，@mention 路由（`@all` / `@所有人` 广播，无 @ 时全员回复）；同 session 消息经 promise chain 串行处理（灭回复颠倒与 set_mode 交错）
- **Intermind 私信** — 人形间写信型私信：`send_private_message` 写信入 `intermind:<peer>` 独立会话并触发接收方一轮感知回合即时读信；感知回合内回信搭车（只入队、不再次唤醒，连环惊醒机制上不可能）；免审批但需工具白名单显式授权，warn 级审计留痕；傀儡硬禁邮（swarm 无法轰炸）；`read_private_messages` 可读完整来往信件（不受 200 字摘要截断）；设计定案见 [`docs/design/intermind.md`](docs/design/intermind.md)
- **Agent 管理** — 创建、编辑、删除 Agent（基本资料 / 人设 / 模型 / Skill / 工具 / 外观）
- **工具调用** — ReActLoop 调用 13 个内置工具（真实清单见 `services/engine/src/tools/builtin/index.ts`）：
  - `read_file` — 读取工作区文件（免审批）
  - `write_file` — 写文件（需人工审批）
  - `bash` — 在工作区执行允许的 shell 命令（需人工审批）
  - `list_files` — 列出目录内容（免审批）
  - `edit_file` — 精确编辑文件（需人工审批）
  - `run_command` — 运行命令（需人工审批）
  - `dispatch_subagent` — 前台/后台借用人形执行子任务（需人工审批）
  - `dispatch_subagent_batch` — ≤16 items 批量 swarm 全傀儡派发（需人工审批）
  - `skill` — 按名取回 SKILL.md 规程正文（免审批）
  - `web_search` — Tavily 联网搜索（需人工审批，可「本会话免问」）
  - `send_private_message` — Intermind 私信写信（免审批，需白名单授权）
  - `read_private_messages` — 读取与对端的完整来往私信（免审批，需白名单授权）
  - `recall` — 浏览压缩档话题、取回归档原文（免审批）
- **MCP 接入** — 经 `DATA_DIR/mcp-servers.json` 配置接入 stdio MCP server，工具以 `mcp__<server>__<tool>` 命名（64 字符封顶哈希后缀）注入 Agent 工具管线；审批 fail-closed（仅 `readOnlyHint===true` 免审批），`toolOverrides` 可按限定名本地覆盖（免审批/强制审批/`allowRemember` 放行「本会话免问」，默认禁）；调用失败自愈封顶一次（ping 探活分流 + single-flight 重连后重试），server 崩溃工具不消失（断线保注册）；单 server 失败降级（记 warn，不阻塞整体）
- **上下文管线** — ContextPipeline L1–L6 分层组装，tiktoken 真实计数，超预算按 L5 → L4 → L6-ext → L3 自动降级；话题压缩归档（L5 摘要注入）与 L4 语义检索已接入管线（Phase 1–3）
- **上下文水位与换班** — 上下文用量主裁 = 估算 + 实测双轨（协议感知估算，步后 usage 实测取大）：≥70% 注入提醒、≥90% 撞顶自动产出 `[交接书]` 并换班续跑（回合绝不静默）；交接书四件套 = 三分法内容 / 足迹机械附 / 瘦身写作间 / 开工指引，`handoffMaxShifts` 保险丝（缺省 5，clamp 1-10）封顶棒数；跨连接 cancel 统一走 registry 仲裁面 + chainId 代际防旧链复活；机制细节见 [`docs/架构文档.md`](docs/架构文档.md)
- **长期记忆** — per-Agent JSON/JSONL 文档存储（原子写）；旧话题经 LLM 压缩为摘要归档（`_compressed/`），原始消息移入归档可恢复
- **心智系统** — SOUL.md 人格核心注入 L1；MIND.md 动态经验档案（话题压缩时 LLM 沉淀、置信度过滤、注入防御）
- **向量记忆** — 经 Rust sidecar（HNSW）的跨会话语义检索，作为 L4 层注入上下文（相似度 × 分段时间衰减打分、已压缩话题原文排除），需配置 embedder 并运行 sidecar（桌面端自动启动，不可用时静默降级）
- **Skill 系统** — 基于 SKILL.md 的技能加载（内置目录 / 全局目录 / Agent 私有目录），已工具化：L1 只注技能目录（名字+一句话）作发现入口，规程正文经 `skill` 工具按名取回（不预塞全文进上下文）；技能不存在返回可用列表（fail-closed）；活跃保护——话题压缩摘要记 usedSkills，组装时自动重取规程正文（尾部 system 注入，取失败跳过）；`POST /agents/:id/skills/reload` 热重载；调用记录落 `skill-history.jsonl`（`GET /agents/:id/skill-history` 查询）
- **Plan / Subagent** — 计划管理（REST，plans.jsonl 持久化，重启自动恢复）与 `dispatch_subagent` 工具（前台/后台借用其他 Agent；后台任务持久化 subagent-tasks.jsonl，重启 running 标 lost，输出超 ~4KB 截尾 preview + 全量 log 双轨；`kind` 分型——delegate 借用人形 / puppet 傀儡：调用方的一次性分身，无 SOUL 无记忆、记忆即弃，用主人的模型与工具裸跑，写类操作回主人会话审批）；终态任务可 resume（`POST /agents/:id/subagents/:taskId/resume`，同简报重跑、复用记录 attempts+1）；任务终态通知注入 owner 感知回合（开关 `subagentNotify` 缺省开）；`dispatch_subagent_batch` 批量 swarm（模板 × ≤16 items 全傀儡派发，burst 坡道 + 429 限流自适应续跑，结果 XML 原位聚合，无审批桥接——面向只读/分析/汇总类批量任务）
- **定时任务** — Cron 调度，到点自动给 Agent 派发任务
- **算力平台** — LLM Provider 管理（API Key AES-256-GCM 加密存储、baseUrl SSRF 校验、连接测试）；错误分类重试（429/5xx/网络/超时指数退避）+ Agent 级备用 Provider 降级链（`fallbackProviderIds`）；型号级 `apiMode` 三族协议切换（`chat_completions` / `anthropic` / `responses`，缺省回落 provider 级），配置热更下一次调用即生效、无需重启
- **蓝图工作流** — start / llm / tool / end 节点编排（线性链）
- **会话模式** — chat / code 双模式，code 模式下工具可访问项目目录
- **桌面应用** — Tauri 启动 Rust sidecar，sidecar 守护 Node 引擎（失败自动重启）

> 规划中：蓝图分支/并行/审批、公共 Skill 池、generate_image 工具、多用户
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
# 启动全部 dev 目标：engine + web + shared（tsc --watch）+ desktop（tauri dev，首次需完整 Rust 编译，耗时数分钟）
pnpm dev

# 只做 Web 开发（engine + web，不拉起桌面端）
pnpm --filter @mindcloud/engine --filter @mindcloud/web dev
```

- 前端：`http://localhost:3000`
- 后端 API：`http://127.0.0.1:8848`（Swagger UI：`http://127.0.0.1:8848/docs`）

### 4. 单独启动桌面

```bash
pnpm --filter @mindcloud/desktop dev
```

---

## 核心概念

### Agent = 独立数字生命

每个 Agent 拥有：
- **私有记忆** — per-Agent JSON/JSONL 文档存储
- **独立配置** — 自己的模型、人设、Skill、工具
- **工具权限** — 可调用文件、Shell、子代理等内置工具，写操作与子代理派发需人工审批
- **Plan 执行** — 通过 Plan 系统编排多步骤任务
- **Skill 扩展** — 基于 SKILL.md manifest 动态加载能力

### ReAct 循环

每轮对话中，引擎先经 ContextPipeline 组装上下文，再由 ReActLoop 决定：
- 直接回复用户
- 调用一个或多个工具
- 创建/更新 Plan 或 Subagent

### 单用户本地模式

- 无登录注册，开箱即用
- 所有数据存储在本地。独立运行 engine（如 Web 模式 `pnpm dev`）默认 `~/.cloudmind-zome`；桌面端由 sidecar 解析统一数据目录（Windows 为 `%LOCALAPPDATA%\cloudmind-zome`）并在启动 engine 时注入，旧默认目录的数据由 sidecar 启动时一次性迁移
- 两种形态均可通过环境变量 `CLOUDMIND_DATA_DIR` 覆盖默认路径
- 可作为 Web 应用或 Tauri 桌面应用运行

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 后端引擎 | Node.js + TypeScript + Fastify 5 |
| 前端 | Nuxt 3 + Vue 3 + Pinia + TypeScript |
| 桌面 | Tauri 2 + Rust + WebView2 |
| 性能侧车 | Rust（zome-sidecar）+ gRPC（HNSW 向量搜索；另有 tokenizer / 进程守护能力） |
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
├── tests/             # Playwright e2e 测试
├── spikes/            # 技术验证（throwaway 实验）
├── docs/              # 项目文档
└── scripts/           # 构建辅助脚本
```

---

## 数据存储

所有运行时数据本地存储。独立运行 engine（Web 模式）默认 `~/.cloudmind-zome`（Windows 上为 `%USERPROFILE%\.cloudmind-zome`）；桌面端由 sidecar 解析统一数据目录（Windows 为 `%LOCALAPPDATA%\cloudmind-zome`），旧默认目录的数据会被一次性迁移。均可通过环境变量 `CLOUDMIND_DATA_DIR` 覆盖。

```
DATA_DIR/
├── config.json            # 全局配置（Provider、记忆参数；凭据加密落盘）
├── .master-key            # 自动生成的 AES 主密钥
├── blueprints.jsonl       # 蓝图定义
├── skills/                # 全局 Skill 目录
└── agents/{agentId}/      # 每个 Agent 的私有工作区
    ├── agent.json         # Agent 配置
    ├── messages.jsonl     # 会话消息（热存储）
    ├── messages_archived.jsonl  # 已归档消息（话题压缩后移入，可恢复）
    ├── _compressed/       # 话题压缩档（markdown + frontmatter）
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
