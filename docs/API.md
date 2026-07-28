# CloudMind Zome Engine API

Engine 默认监听 `http://127.0.0.1:8848`（可用 `PORT` 环境变量修改）。所有端点**无前缀**（直接挂在根路径下）。

## OpenAPI / Swagger

启动 engine 后访问：

```
http://127.0.0.1:8848/docs
```

Swagger UI 包含所有 REST 端点的摘要、标签和参数说明，可用于在线调试。

## 主要端点

### Health

- `GET /health` — 健康检查，返回 `{ "status": "ok" }`

### Agents

- `GET /agents` — 列出所有 Agent
- `POST /agents` — 创建 Agent
- `GET /agents/:id` — 获取 Agent
- `PUT /agents/:id` — 更新 Agent
- `DELETE /agents/:id` — 删除 Agent

**Agent 配置项（`AgentConfig`，创建/更新时可传的可选字段）**：

| 字段 | 类型 | 缺省 | 说明 |
|---|---|---|---|
| `maxContextTokens` | number | 80000 | 上下文窗口总预算（32k/128k 窗口模型应显式配置） |
| `compressionModel` | string | 主模型 | 话题压缩模型；压缩失败不 fallback 主模型 |
| `topicDetectionWindowMinutes` | number | 30 | 话题检测时间窗（分钟），超过视为新话题 |
| `topicMessageThreshold` | number | 20 | 当前话题消息数达到该值即关闭并压缩 |
| `semanticSearchEnabled` | boolean | true | 语义检索（L4）开关，同时门控检索与 embed 索引 |
| `semanticTopK` | number | 10 | L4 注入条数上限 |
| `semanticMinScore` | number | 0 | L4 最低相关度（相似度 × 时间衰减，0-1） |

> 非法取值由引擎归一并 warn：`topicMessageThreshold < 4` clamp 到 4；`semanticTopK < 1` 重置为默认值 10。ID 仅允许 `[a-zA-Z0-9_-]{1,64}`。

### Chat

- `GET /chat/:agentId/messages?sessionId=xxx&limit=xxx` — 获取历史消息（`sessionId` 必填）
- WebSocket `GET /ws/:agentId?sessionId=xxx` — 与单个 Agent 实时对话（sessionId 缺省 `default`）

### Sessions（群聊）

- `GET /sessions` — 列出所有会话
- `POST /sessions` — 创建群聊会话
- `GET /sessions/:id` — 获取会话
- `PUT /sessions/:id` — 更新会话
- `DELETE /sessions/:id` — 删除会话
- `GET /sessions/:id/messages?limit=xxx` — 获取会话历史消息（合并各成员仓库：按消息 id 去重，assistant/tool 消息带 `agentId` 归属标注，`limit` 为合并后总量）
- WebSocket `GET /ws/sessions/:sessionId` — 群聊实时对话

### Compute

- `GET /compute/providers` — 列出 Provider
- `POST /compute/providers` — 创建 Provider
- `PUT /compute/providers/:id` — 更新 Provider
- `DELETE /compute/providers/:id` — 删除 Provider
- `POST /compute/providers/:id/test` — 测试 Provider 连接
- `GET /compute/usage` — 获取用量统计
- `POST /compute/providers/:id/models` — 为 Provider 添加模型
- `PUT /compute/providers/:id/models/:modelId` — 更新模型
- `DELETE /compute/providers/:id/models/:modelId` — 删除模型

### Config

- `GET /config` — 获取系统设置（凭据脱敏为 `"***"`）
- `PUT /config` — 更新系统设置
- `GET /config/tools` — 列出内置工具

### Blueprints

- `GET /blueprints` — 列出 Blueprint
- `POST /blueprints` — 创建 Blueprint
- `GET /blueprints/:id` — 获取 Blueprint
- `PUT /blueprints/:id` — 更新 Blueprint
- `DELETE /blueprints/:id` — 删除 Blueprint
- `POST /blueprints/:id/execute` — 执行 Blueprint

### Scheduler

- `GET /scheduler/:agentId` — 列出 Agent 的定时任务
- `POST /scheduler/:agentId` — 创建定时任务
- `PUT /scheduler/:agentId/:taskId` — 更新任务
- `DELETE /scheduler/:agentId/:taskId` — 删除任务

### Plans

- `POST /agents/:agentId/plans` — 创建计划
- `GET /agents/:agentId/plans` — 列出计划
- `GET /agents/:agentId/plans/:planId` — 获取计划
- `POST /agents/:agentId/plans/:planId/run` — 执行
- `POST /agents/:agentId/plans/:planId/pause` — 暂停
- `POST /agents/:agentId/plans/:planId/resume` — 恢复
- `POST /agents/:agentId/plans/:planId/retry` — 重试指定步骤

> 计划存储在内存中，engine 重启后丢失。

### Subagents

- `GET /subagents/background` — 列出后台子代理任务
- `GET /subagents/background/:taskId` — 查询单个后台任务

> 子代理通过 `dispatch_subagent` 工具创建，无 REST 创建端点。

### Memory

- `GET /memory/:agentId?limit=xxx&offset=xxx` — 列出 Agent 的记忆
- `GET /memory/:agentId/:id` — 获取单条记忆

### Actions

- `GET /actions/:agentId?limit=xxx&offset=xxx` — 列出 Agent 的动作记录

### Skills

- `GET /skills` — 列出可用 Skill

### Logs

- `GET /logs` — 查询 engine 内存环形缓冲中的日志

## WebSocket 协议

**Client → Server**：

| 帧 | 说明 |
|---|---|
| `{ "text": "..." }` | 聊天消息（无 type 字段，最长 10000 字符） |
| `tool.approval` | 审批回执（`approvalId` / `approved` / `remember`；`run_command` / `write_file` / `edit_file` / `dispatch_subagent` 不可 remember） |
| `session.set_mode` | 切换 chat / code 模式（仅会话 WS，可带 `projectId`） |

未知 type 帧静默忽略。

**Server → Client**：

| 帧 | 说明 |
|---|---|
| `text.delta` / `thinking.delta` | 流式正文 / 推理内容（群聊帧带 `agentId`） |
| `tool.call` / `tool.result` | 工具调用与执行结果（群聊帧带 `agentId`） |
| `step.end` | ReAct 单步结束（每个 step 都发，tool_use 时循环继续） |
| `turn.end` | 一轮生成结束（ReAct 循环退出；前端在此复位"生成中"状态） |
| `tool.approval_request` | 审批请求（60s 未回复视为拒绝） |
| `session.mode_changed` | 模式切换确认（仅会话 WS） |
| `error` | 错误 |

握手时校验 Origin（无 Origin 的非浏览器客户端放行；`tauri://` 协议及 `*.tauri.localhost` 域放行；`NODE_ENV=e2e` 全放行）。

## 通用约定

- 所有 REST 响应均为 JSON。
- 删除操作成功返回 `204 No Content`。
- 资源不存在返回 `404 Not Found`。
- 参数校验失败返回 `400 Bad Request`。
- 实现细节见 `services/engine/src/api/routes/` 与 `services/engine/src/api/ws/`。
