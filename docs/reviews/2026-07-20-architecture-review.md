# CloudMind-Zome 架构审查报告

生成时间：2026-07-20
版本：v2.0.0
分支：main（`449293f`）

---

## 一、项目概况

CloudMind-Zome 是一个本地优先、单用户的多 Agent 桌面平台。核心使命是让每个 Agent 成为有连续记忆、独立人格的数字生命（"人形"）。

**技术栈**：
- 前端：Nuxt 3 + Vue 3 + TypeScript
- 后端：Fastify 5 + TypeScript（engine）
- 桌面端：Tauri 2 + Rust
- 计算后端：Rust sidecar（向量索引、tokenizer）
- 包管理：pnpm + turbo monorepo
- 测试：Vitest + Playwright

**代码规模**：
- engine（TS）：~2,848 行
- web（Vue/TS）：~6,252 行
- shared（TS）：39 行
- sidecar（Rust）：~601 行
- desktop（Rust）：156 行
- **总计**：~9,900 行

---

## 二、Monorepo 结构

```
MindCloud-Zome/
├── apps/
│   ├── web/          # Nuxt 3 前端（端口 3000）
│   └── desktop/      # Tauri 2 桌面壳
├── services/
│   └── engine/       # Fastify 5 后端（端口 8848）
├── packages/
│   ├── shared/       # 共享类型定义
│   └── skills/       # Skill 系统（预留）
├── crates/
│   └── zome-sidecar/ # Rust 计算后端
├── docs/             # 设计文档、review、问题跟踪
├── tests/e2e/        # Playwright 端到端测试
└── workspace/        # Agent 工作区（memory、skills、tools）
```

---

## 三、Engine 架构（services/engine）

### 3.1 入口与启动

- `bootstrap.ts`：启动入口，初始化 Fastify、注册路由、启动 scheduler、连接 sidecar
- `server.ts`：Fastify 实例配置（CORS、WebSocket、Swagger）

### 3.2 API 层

**REST 路由**（`api/routes/`）：
| 文件 | 功能 |
|------|------|
| `agents.ts` | Agent CRUD |
| `chat.ts` | 会话管理 |
| `compute.ts` | LLM Provider 管理 |
| `config.ts` | 系统配置 |
| `memory.ts` | 记忆检索 |
| `plans.ts` | 计划任务 |
| `scheduler.ts` | 定时任务 |
| `skills.ts` | Skill 管理 |
| `subagents.ts` | 子 Agent |
| `blueprints.ts` | 蓝图（工作流） |
| `actions.ts` | 行动记录 |
| `logs.ts` | 日志查询（新增） |
| `sessions.ts` | 会话历史 |

**WebSocket**（`api/ws/`）：
- `handler.ts`：主聊天 WS，处理 text.delta / thinking.delta / tool_call / approval
- `session-handler.ts`：会话级 WS
- `validation.ts`：帧格式校验（新增）

### 3.3 核心层

**ReAct 循环**（`core/react/`）：
- `turn.ts`：单轮对话主循环，集成 ContextPipeline
- `step.ts`：单步执行（LLM 调用 + 工具调用）
- `tool-call.ts`：工具调用封装
- `tool-scheduler.ts`：工具调度（审批门控）

**AgentWorker**（`core/agent-worker.ts`）：
- 管理 Agent 的会话队列、mindContext 拼接、调用 runTurn

### 3.4 ContextPipeline（新增，Phase 1）

**文件**（`context/`）：
| 文件 | 功能 |
|------|------|
| `token-counter.ts` | tiktoken 准确计数 |
| `layers.ts` | L1-L6 分层定义 |
| `downgrade.ts` | L5→L4→L6-ext→L3 降级策略 |
| `pipeline.ts` | 主类，组装 + 降级循环 |
| `assembler.ts` | 按层级组装 messages |
| `truncate.ts` | 工具结果截断（保留头尾） |

**分层**：
- L1：人格系统提示（永不压缩）
- L2：@提及提醒（永不压缩）
- L3：短期对话历史（可截断）
- L4：长期记忆检索（未实现，Phase 3）
- L5：文件上下文（可移除）
- L6：工具定义（L6-core 永不压缩 / L6-ext 可 LRU 裁剪）

### 3.5 记忆系统

**存储**（`memory/`）：
- `document-store.ts`：文档存储（原子写入，Windows 文件锁兼容）
- `indexer.ts`：向量索引（通过 sidecar）
- `repositories/`：Agent、Message、Memory、Action、LLMCall 的 CRUD

**数据目录**：`~/.cloudmind-zome/agents/{agentId}/`

### 3.6 Provider 层

- `llm.ts`：OpenAI 兼容 API 封装（支持 DeepSeek）
- `embedder.ts`：Embedding 模型（Mock / OpenAI / sidecar）
- `image-gen.ts`：图像生成（预留）

### 3.7 Sidecar 客户端

- `sidecar/client.ts`：gRPC 客户端，调用 Rust sidecar
- 功能：向量索引、tokenizer、embedding

---

## 四、Web 前端架构（apps/web）

### 4.1 页面

| 页面 | 路径 | 功能 |
|------|------|------|
| `index.vue` | `/` | 主页（通讯中枢入口） |
| `hub.vue` | `/hub` | 通讯中枢（私聊/群聊） |
| `agents/new.vue` | `/agents/new` | 新建/编辑 Agent |
| `agents/[id]/index.vue` | `/agents/:id` | Agent 详情 |
| `agents/[id]/edit.vue` | `/agents/:id/edit` | 编辑 Agent（预留） |
| `sessions/[id].vue` | `/sessions/:id` | 会话详情 |
| `settings.vue` | `/settings` | 系统设置 |
| `compute.vue` | `/compute` | 算力管理 |
| `scheduler.vue` | `/scheduler` | 定时任务 |
| `blueprints/` | `/blueprints/*` | 蓝图编辑/执行 |

### 4.2 组件

**聊天相关**：
- `ChatView.vue`：私聊主界面
- `GroupChatView.vue`：群聊界面
- `MessageBubble.vue`：消息气泡（流式输出 UI：打字机 + 思考折叠 + 工具卡片）
- `MessageInput.vue`：输入框
- `ApprovalCard.vue`：工具审批卡片

**面板**：
- `LogPanel.vue`：日志查看（接入真实 engine 日志）
- `SystemSettingsPanel.vue`：系统设置面板
- `WallpaperPanel.vue`：壁纸面板

**其他**：
- `BackButton.vue`：返回按钮
- `ModelSelector.vue`：模型选择器
- `BlueprintCanvas.vue`：蓝图画布

### 4.3 状态管理

**Stores**（Pinia）：
- `chat.ts`：私聊状态（WS 连接、消息流、审批）
- `agents.ts`：Agent 列表
- `sessions.ts`：会话历史
- `blueprints.ts`：蓝图
- `compute.ts`：Provider
- `settings.ts`：系统配置
- `scheduler.ts`：定时任务
- `self-image.ts`：自我形象
- `user-profile.ts`：用户档案

### 4.4 Composables

- `useEngineClient.ts`：Engine API 封装（REST + WS），模块级单例
- `useChatRecords.ts`：消息记录处理（新增，提取公共逻辑）

---

## 五、桌面端（apps/desktop）

- Tauri 2 壳，加载 `localhost:3000`
- `sidecar.rs`：启动 Rust sidecar 进程
- `commands.rs`：Tauri 命令（获取后端 URL 等）

---

## 六、Sidecar（crates/zome-sidecar）

**功能模块**：
- `crypto/`：加密（预留）
- `sandbox/`：沙箱（预留）
- `supervisor/`：进程监督
- `tokenizer/`：HuggingFace tokenizer
- `vector/`：向量索引（sqlite-vec）

**服务**：gRPC 服务器，端口 50051

---

## 七、数据流

### 7.1 聊天流程

```
用户输入 → ChatView → chat store → useEngineClient
  → WS /ws/{agentId}?sessionId=...
  → engine handler.ts → AgentWorker
  → ContextPipeline.assemble（L1-L6 组装）
  → LLM Provider（DeepSeek/OpenAI）
  → text.delta / thinking.delta / tool_call 帧
  → 前端 MessageBubble 流式渲染
```

### 7.2 记忆流程

```
对话消息 → memory/repositories/message.ts → DocumentStore
  → memoryIndexer（非 Mock embedder 时）
  → sidecar gRPC → vector 索引
```

---

## 八、测试状态

| 项目 | 测试数 | 状态 |
|------|--------|------|
| engine | 366 | 全过 |
| web | 46 | 全过 |
| e2e | 2 | 全过 |
| typecheck | 4 包 | 全过 |

---

## 九、近期完成的工作（07-17 至今，48 commits）

**ContextPipeline Phase 1**：
- token 计数、L1-L6 分层、降级策略、集成 turn.ts
- 13 个 mock 集成测试
- 3 个 Major 修复（工具结果截断、maxContextTokens 配置化、降级日志）

**Engine 修复**：
- CORS 方法显式声明
- Agent id 回填
- WS 消息缓冲（初始化期间不丢消息）
- 日志内存缓冲 + GET /logs

**Web 前端**：
- 全面排查 2 轮（4 Blocker + 14 Major + 16 Minor）
- Review 追加 3 项修复
- 流式输出 UI（打字机 + 思考折叠 + 工具卡片）
- 6 项体验优化（LogPanel、fetch 超时、WS 校验、tavily 清除、GroupChatView、模块级单例）

---

## 十、已知问题与待办

**已修复**：
- bootstrap.ts:132 tools undefined 崩溃
- scheduler 每 5 秒报错
- CORS 预检失败
- WS 消息丢失
- 前端 unhandled rejection
- 蓝图执行超时
- thinking.delta 帧名不匹配

**待决策**：
- `/agents` 列表页 + `/agents/:id/edit` 编辑页拆分（原型已确认，待实现）
- LogPanel 定时轮询（当前手动刷新）

**待实现（ContextPipeline）**：
- Phase 2：话题检测（规则版）+ LLM 压缩 + 归档
- Phase 3：L4 语义检索注入 + 时间衰减
- Phase 4：优化（LLM 话题检测、双程压缩等）

**文档**：
- README 部分"已实现"声明与实际代码不符（待修正）
- 路线图日期过期（待更新）

---

## 十一、架构评估

**优点**：
1. 分层清晰：engine / web / desktop / sidecar 职责明确
2. ContextPipeline 设计完整：L1-L6 分层 + 降级策略，为长期记忆打下基础
3. 测试覆盖好：engine 366 + web 46 + e2e，核心路径有保护
4. 类型安全：全 TypeScript，shared 包统一类型
5. 本地优先：数据本地存储，无外泄风险

**风险点**：
1. 单点故障：engine 挂则全系统不可用（无高可用）
2. 数据迁移：暂无版本化迁移机制（Agent 配置、记忆格式变更时可能丢数据）
3. 性能瓶颈：消息全量加载（无分页），长期对话可能卡顿
4. 并发限制：单用户设计，无多 Agent 并发控制

**建议**：
1. 优先实现 Phase 2（话题压缩），解决长期对话的上下文膨胀
2. 加消息分页加载（虚拟滚动）
3. 加数据版本标记 + 迁移脚本
4. 考虑 engine 崩溃自动重启（supervisor 模式）

---

## 十二、总结

CloudMind-Zome 地基已稳。ContextPipeline Phase 1 完成，前端体验接近 Hermes，测试覆盖核心路径。下一步建议：

1. **短期**（本周）：实现 `/agents` 列表页拆分，修正 README
2. **中期**（下周）：启动 Phase 2（话题压缩），让 Agent 真正能"记住"长期对话
3. **长期**：Phase 3（L4 语义检索），完善数字生命的记忆连续性

项目正朝着"让人形成为现实"的目标稳步推进。

---

## 勘误（2026-07-21 补注）

本报告为 2026-07-20 时点快照，以下条目与当前代码不符，予以勘正：

- §六："向量索引（sqlite-vec）"有误——sidecar 实际使用自研 instant-distance HNSW（内存索引 + JSONL 持久化），非 sqlite-vec。
- §4.1 页面表：`agents/[id]/index.vue` 与 `agents/[id]/edit.vue` 不存在——实际为单一 `pages/agents/[id].vue`（`/agents/new` 由同一文件处理）。
- §十"待决策"中的 `/agents` 列表页 + 编辑页拆分：至今未实现，`/agents/:id` 仍是唯一编辑入口。

---

报告完毕。指挥官，明早见。
