# CloudMind Zome Engine API

Engine 默认监听 `http://127.0.0.1:8848`。

## OpenAPI / Swagger

启动 engine 后访问：

```
http://127.0.0.1:8848/docs
```

Swagger UI 包含所有 REST 端点的摘要、标签和参数说明，可用于在线调试。

## 主要端点

### Agents

- `GET /agents` — 列出所有 Agent
- `POST /agents` — 创建 Agent
- `GET /agents/:id` — 获取 Agent
- `PUT /agents/:id` — 更新 Agent
- `DELETE /agents/:id` — 删除 Agent

### Chat

- `GET /chat/:agentId/messages?sessionId=xxx&limit=xxx` — 获取历史消息
- WebSocket `/ws/:agentId?sessionId=xxx` — 与单个 Agent 实时对话

### Sessions（群聊）

- `GET /sessions` — 列出所有会话
- `POST /sessions` — 创建群聊会话
- `GET /sessions/:id` — 获取会话
- `PUT /sessions/:id` — 更新会话
- `DELETE /sessions/:id` — 删除会话
- `GET /sessions/:id/messages` — 获取会话历史消息
- WebSocket `/ws/sessions/:sessionId` — 群聊实时对话

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

- `GET /config` — 获取系统设置
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

### Memory

- `GET /memory/:agentId?limit=xxx&offset=xxx` — 列出 Agent 的记忆
- `GET /memory/:agentId/:id` — 获取单条记忆

### Actions

- `GET /actions/:agentId?limit=xxx&offset=xxx` — 列出 Agent 的动作记录

### Skills

- `GET /skills` — 列出可用 Skill

## 通用约定

- 所有 REST 响应均为 JSON。
- 删除操作成功返回 `204 No Content`。
- 资源不存在返回 `404 Not Found`。
- 参数校验失败返回 `400 Bad Request`。
- WebSocket 帧格式为 JSON，具体事件类型见 `services/engine/src/api/ws/handler.ts`。
