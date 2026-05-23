# CloudMind-Zome 改动日志 2026-05-22

## 1. 后端模型层

### 1.1 `backend/app/models/chat.py`
- **ChatSessionMember** 新增字段：
  - `is_pinned: bool` (默认 False) - 会话置顶
  - `last_read_at: Optional[DateTime]` - 最后已读时间
  - `last_disconnect_at: Optional[DateTime]` - 最后离线时间（用于离线消息回放）
- **ChatSession** 新增字段：
  - `status: str` (默认 "active") - 群聊状态 (active / dissolved)
- **ChatMessage** 新增字段：
  - `client_msg_id: Optional[str]` - 客户端消息ID，用于去重
  - `content_type: str` (默认 "text") - 消息类型 (text / image / file / system)
  - `reply_to: Optional[str]` - 引用回复的消息ID

### 1.2 `backend/app/models/users.py`
- **User** 新增字段：
  - `last_seen_at: Optional[DateTime]` - 最后在线时间

### 1.3 `backend/app/models/agents.py`
- **Agent** 新增字段：
  - `tags: JSON` (默认 []) - Agent 标签数组

## 2. 后端 API 层

### 2.1 `backend/app/api/ws.py`
- 新增 `chat.ack` 帧：服务端接收消息后回复确认（client_msg_id）
- 新增 `client_msg_id` 去重逻辑：使用 `recent_msg_ids` Set 防重发
- 新增离线消息回放：连接时检测 `last_disconnect_at`，发送期间缺失消息
- 新增 `chat.typing` 帧广播：用户输入状态同步
- 支持 `content_type`、`reply_to`、`client_msg_id` 字段接收
- 修复：`selectinload` 防 MissingGreenlet
- 修复：`exc` 变量引用（在 `except` 块外使用前赋值）
- 移除 `?token=` Query 参数，guest 模式直接连接

### 2.2 `backend/app/api/chat.py`
- `list_sessions`：
  - 新增 `is_pinned` 排序（置顶优先）
  - 返回成员级 `is_pinned` 字段
  - 过滤已解散群聊 `status != "dissolved"`
- `get_messages`：
  - 新增 `search` 查询参数：关键词搜索消息内容
  - 返回 `content_type` 字段
  - 解析 `reply_to` 引用预览（查 DB 获取原消息 sender/content）
- 新增 `PUT /sessions/{id}/pin`：切换置顶状态
- 新增 `PUT /sessions/{id}/read`：标记已读（更新 `last_read_at`）

### 2.3 `backend/app/api/groups.py`
- 新增 `DELETE /{group_id}`：解散群聊（仅群主可操作）
  - 设置 `status = "dissolved"`
  - 群名追加 "(已解散)"

### 2.4 `backend/app/api/agents.py`
- `AgentCreate` / `AgentUpdate` / `AgentItem` Schema 新增 `tags: List[str]` 字段

## 3. 后端服务层

### 3.1 `backend/app/services/group_chat_router.py`
- `@所有人` / `@all` / `@全体成员` 支持：
  - mentions 解析时识别全员 at，返回所有 agent 成员

### 3.2 `backend/app/services/event_bus.py`
- 单设备登录：同一用户新连接断开旧连接

## 4. 前端 store 层

### 4.1 `frontend/src/stores/chat.ts`
- `loadMessages(sessionId, search?)`：支持搜索参数
- `onMessagePush`：新增 `id` 去重逻辑

### 4.2 `frontend/src/composables/useWebSocket.ts`
- `sendChat`：支持 `content_type`、`reply_to`、`client_msg_id`
- 新增 `sendTyping(sessionId, isTyping)` 函数
- 新增 `chat.ack` 事件分发

## 5. 前端组件层

### 5.1 `frontend/src/components/ChatView.vue`（重写）
- 搜索框：header 右侧搜索按钮，展开搜索栏，支持关键词搜索消息
- 引用显示：消息气泡内渲染 `reply_to` 内容（sender + content）
- 图片发送：输入区左侧 "+" 按钮，选择图片后上传并发送 image 消息
- 图片预览：点击消息中图片打开全屏 overlay
- 时间分割线：按日期自动插入分割线
- ACK 状态：监听 `ws:chat.ack` 事件
- Typing 同步：textarea input 事件触发 `sendTyping`，2秒后停止
- 引用回复：可选引用某条消息（UI 预留 replyTarget）

## 5. 前端组件层（续）

### 5.2 `frontend/src/components/GroupChatView.vue`（重写）
- 所有 ChatView 新功能：搜索框、引用显示、图片发送/预览、时间分割线、ACK、typing
- **@所有人**：mention 框顶部添加 "@所有人" 选项
- **解散群聊**：群设置面板添加 "解散群聊" 按钮（仅群主可见）

### 5.3 `frontend/src/components/CommunicationHub.vue`
- **置顶功能**：每个会话项右上角显示星标按钮，置顶项左侧加金色边框
- **Agent 分组显示**：私聊 tab 按 `tags[0]` 分组显示 Agent，无标签归为默认组
- 后端 `list_sessions` 已按 `is_pinned` 排序，置顶项自然排在前面

### 5.4 `frontend/src/components/AgentEdit.vue`
- **分组标签输入**：skills 面板新增 "分组标签" 区域，黄色标签样式，支持增删
- `form.tags` 绑定，create/update/select 全链路支持

## 6. 深度 Review 排查出的隐藏 Bug (2026-05-22 追加)

### 6.1 第一轮修复（群聊不回复）

| 问题 | 位置 | 影响 |
|------|------|------|
| `GroupChatRouter` 默认 `routing_mode = "mention"` | `group_chat_router.py` | 旧群聊/无 settings 时，不@任何人 → targets 为空 → 静默返回 |
| `targets` 为空时直接 `return` | `ws.py` | 前端无任何反馈，用户不知为何无回复 |
| `AgentWorker` error event 不回调 `on_chunk` | `agent_worker.py` | LLM 失败时，stream_chat 收到 done 直接返回，full_content 为空 → 不发送任何消息 |
| `_react_agent` 为 None 时不调用 `on_done` | `agent_worker.py` | Worker 启动失败时，`stream_chat` 挂起 600 秒直到超时 |

**修复**：`routing_mode` 默认改 `"intent"`；`targets` 为空发系统提示；error 时回调 `on_chunk`；`_react_agent` 为 None 时调用 `on_done`。

### 6.2 第二轮 Review 发现的问题

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| 1 | `broadcast_to` 未定义（NameError） | `ws.py` `_handle_chat_send` | 群聊 `targets` 为空时系统提示无法广播给其他成员，直接 500 崩溃 |
| 2 | `pin_session` 接收 query 参数 `pinned=True` | `chat.py` | 前端 `togglePin` 无法取消置顶，永远设为 True |
| 3 | `togglePin` 不传 `pinned` 值 | `CommunicationHub.vue` | 配合后端 bug，置顶功能完全失效 |
| 4 | `engine_bridge._build_transport` 引用 `self.db` | `engine_bridge.py` | 死代码但含 `AttributeError`，若被调用直接崩溃 |
| 5 | `create_agent` 漏传 `tags` | `agents.py` | 新建 Agent 时 tags 丢失 |
| 6 | `list_agents` 不返回 `tags` | `agents.py` | 前端 `CommunicationHub` Agent 分组依赖 `a.tags`，分组永远为空 |
| 7 | `Message.get_text()` 不处理 `ToolResultBlock` | `engine/message/types.py` | Tool 执行结果在历史消息中丢失为空白，Agent 看不到工具返回内容 |

### 6.3 修复内容

- **`ws.py`**：`broadcast_to` → `other_members`
- **`chat.py`**：`pin_session` 改为从 body 接收 `PinReq`
- **`CommunicationHub.vue`**：`togglePin` 传 `{ pinned: !current }`
- **`engine_bridge.py`**：`_build_transport` 改用独立 `AsyncSessionLocal()`
- **`agents.py`**：`create_agent` 加 `tags=body.tags`；`list_agents` 返回 `tags`
- **`engine/message/types.py`**：`get_text()` 增加 `ToolResultBlock` 处理

### 6.4 编译检查

- [x] 前端 `vue-tsc --noEmit` 通过
- [x] 后端 `py_compile` 全模块通过
- [x] 后端启动成功，`/api/v1/system/health` 返回正常

## 7. 功能完成清单

| # | 功能 | 状态 |
|---|------|------|
| 1 | 消息搜索 | 后端 `search` 参数 + 前端搜索框 |
| 2 | 引用回复 | 后端 `reply_to` + `get_messages` 解析预览 + 前端 reply-ref 渲染 |
| 3 | 图片发送 | 后端 `content_type='image'` + 前端文件上传 + img 消息渲染 |
| 4 | 离线消息回放 | 后端 `last_disconnect_at` + WS 连接回放 + 前端去重 |
| 5 | @所有人 | `group_chat_router` 支持 `@所有人` / `@all` |
| 6 | 消息送达 ACK | 后端 `chat.ack` 帧 + 前端监听 |
| 7 | 置顶聊天 | 后端 `is_pinned` + 置顶 API + 前端星标按钮 + 排序 |
| 8 | 解散群聊 | 后端 `DELETE /groups/{id}` + 前端解散按钮 |
| 9 | Agent 分组/标签 | 后端 `Agent.tags` + 前端按 tags 分组 + AgentEdit 标签输入 |
| 10 | 系统可靠性层 | 去重、单设备登录、typing 同步、图片预览、时间分割线 |
