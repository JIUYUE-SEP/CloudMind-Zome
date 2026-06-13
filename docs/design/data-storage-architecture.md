# CloudMind-Zome 数据存储架构

> 状态：只读梳理（基于 2026-06-08 代码）。
> 范围：平台层（FastAPI + SQLAlchemy）与引擎层（Agent Engine）共用一套存储。

---

## 1. 数据库 Schema

### 1.1 SQLite 文件位置

| 项目 | 路径 | 定义文件 |
|---|---|---|
| 数据根目录 | `~/.cloudmind-zome` | `backend/app/database.py:22` |
| 数据库文件 | `~/.cloudmind-zome/cloudmind.db` | `backend/app/database.py:24` |
| 连接字符串 | `sqlite+aiosqlite:///{DB_PATH}` | `backend/app/database.py:25` |

说明：
- 平台层（SQLAlchemy）和引擎层（aiosqlite `SessionStore`）共用同一个 `cloudmind.db`。
- WAL mode + foreign keys 在连接时通过 `PRAGMA` 开启。

### 1.2 SQLAlchemy 模型（平台表）

所有模型继承自 `app.database.Base`，定义在 `backend/app/models/*.py`。

| 表名 | 主要字段 | 用途 |
|---|---|---|
| `users` | `id`, `codename`, `nickname`, `password_hash`, `avatar_url`, `level`, `exp`, `role`, `device_id`, `poster_agent_id`, `last_login_at`, `created_at`, `updated_at` | 用户账号 |
| `profiles` | `id`, `user_id`, `observer_agent_id`, `profile_text`, `quote`, `radar(JSON)`, `tags(JSON)`, `is_generating`, `generated_at` | 用户档案 |
| `agents` | `id`, `user_id`, `name`, `codename`, `capabilities(JSON)`, `aliases(JSON)`, `tags(JSON)`, `model_config(JSON)`, `represent_color`, `portrait_url`, `live2d_model_url`, `action_set`, `status`, `role`, `priority_policy`, `daily_token_limit`, `timeout_seconds`, `fact_broadcast`, `sandbox_enabled`, `daily_tokens_used`, `is_observer`, `deleted_at`, `created_at`, `updated_at` | Agent 定义 |
| `chat_sessions` | `id`, `type(private/group)`, `name`, `owner_id`, `conductor_agent_id`, `announcement`, `settings(JSON)`, `status`, `last_message_at`, `created_at`, `updated_at` | 会话/群聊 |
| `chat_messages` | `id`, `session_id`, `sender_id`, `sender_type(user/agent/system)`, `content`, `content_type`, `reply_to`, `client_msg_id`, `batch_id`, `tool_calls(JSON)`, `reasoning`, `is_deleted`, `created_at` | 平台层聊天记录 |
| `chat_session_members` | `id`, `session_id`, `member_id`, `member_type`, `role`, `is_pinned`, `last_read_at`, `last_disconnect_at`, `joined_at` | 会话成员 |
| `actions` | `id`, `user_id`, `name`, `description`, `nodes(JSON)`, `edges(JSON)`, `status`, `last_run_id`, `created_at`, `updated_at` | 工作流定义 |
| `action_runs` | `id`, `action_id`, `status`, `node_states(JSON)`, `logs`, `started_at`, `ended_at`, `created_at` | 工作流运行 |
| `approvals` | `id`, `agent_id`, `tool`, `command`, `source`, `source_id`, `status`, `timeout_seconds`, `requested_at`, `expires_at`, `resolved_at`, `resolver_id`, `reason` | 审批请求 |
| `commissions` | `id`, `user_id`, `agent_id`, `name`, `trigger_type`, `trigger_config(JSON)`, `action_type`, `action_config(JSON)`, `output_target`, `status`, `next_run_at`, `last_run_at`, `last_run_id`, `created_at`, `updated_at` | 主动委托 |
| `commission_logs` | `id`, `commission_id`, `status`, `result_summary`, `executed_at`, `duration_ms` | 委托执行日志 |
| `compute_providers` | `id`, `user_id`, `provider_type`, `display_name`, `api_key_encrypted`, `config(JSON)`, `quota_total`, `quota_used`, `quota_remaining`, `expires_at`, `status`, `last_sync_at`, `created_at`, `updated_at` | 模型供应商 |
| `compute_usage` | `id`, `provider_id`, `date`, `tokens_prompt`, `tokens_completion`, `tokens_total`, `requests_count`, `cost_estimated` | 用量统计 |
| `notifications` | `id`, `user_id`, `category`, `title`, `body`, `target_url`, `related_id`, `is_read`, `read_at`, `created_at` | 通知 |
| `settings` | `id`, `user_id`, `key`, `value(JSON)`, `created_at`, `updated_at` | 用户设置（key-value） |
| `themes` | `id`, `user_id`, `name`, `is_builtin`, `is_active`, `config_json(JSON)`, `created_at`, `updated_at` | 主题 |
| `trash_items` | `id`, `type`, `original_id`, `name`, `description`, `associations(JSON)`, `deleted_at`, `expires_at` | 回收站 |

### 1.3 引擎层表（由 `SessionStore` 在 `cloudmind.db` 中创建）

| 表名 | 说明 |
|---|---|
| `llm_sessions` | API 会话元数据（模型、provider、token 统计、起止时间等） |
| `llm_messages` | 单次 API 调用的消息历史（role/content/tool_calls/reasoning_content 等） |
| `llm_messages_fts` | FTS5 全文索引，关联 `llm_messages` |
| `agent_messages` | **Agent 统一记忆池**，所有 Agent 的所有场景消息都写这里 |
| `agent_messages_fts` | FTS5 全文索引，关联 `agent_messages` |
| `llm_topics` | 已废弃，仅在旧数据兼容时动态创建 |

### 1.4 `agent_messages` 表重点

定义位置：`backend/engine/session/store.py`。

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | 自增主键 |
| `agent_id` | TEXT | Agent 标识 |
| `role` | TEXT | user / assistant / tool / system |
| `content` | TEXT | 文本内容或 tool result content |
| `tool_calls` | TEXT | JSON 序列化的 ToolUseBlock 列表 |
| `tool_call_id` | TEXT | ToolResultBlock.id |
| `tool_name` | TEXT | 首个 tool call 的名字 |
| `reasoning_content` | TEXT | ThinkingBlock 的思考内容 |
| `timestamp` | REAL | ISO 格式时间字符串（由 meta.timestamp 转换） |
| `token_count` | INTEGER | meta.tokens_used |
| `round` | INTEGER | meta.round |
| `compressed` | INTEGER (0/1) | 是否为压缩摘要 |
| `message_uuid` | TEXT | meta.id（shortuuid 生成） |
| `source` | TEXT DEFAULT 'private' | private / group / workflow |
| `source_id` | TEXT | 场景 ID（session_id / group_id / workflow_id） |
| `source_name` | TEXT | 场景可读名称 |
| `sender_id` | TEXT | 发送者 ID |
| `sender_name` | TEXT | 发送者显示名 |

索引：
- `idx_agent_msgs_agent(agent_id)`
- `idx_agent_msgs_source(source, agent_id)`

FTS5：
- 虚拟表 `agent_messages_fts` 索引 `content`, `tool_name`, `reasoning_content`。
- 通过 `INSERT/UPDATE/DELETE` trigger 同步。

---

## 2. 对话消息的写入和读取

### 2.1 写入逻辑

| 项目 | 内容 |
|---|---|
| 写入入口 | `SessionStore.save_agent_message()` |
| 文件路径 | `backend/engine/session/store.py` |
| 写入字段 | `agent_id`, `role`, `content`, `tool_calls`, `tool_name`, `reasoning_content`, `timestamp`, `token_count`, `round`, `compressed`, `message_uuid`, `tool_call_id`, `source`, `source_id`, `source_name`, `sender_id`, `sender_name` |
| 不写入的字段 | **usage / input_tokens / output_tokens / finish_reason / model / provider** 等 LLM 元数据不写入本表 |
| content 处理 | - `str` 直接存<br>- 列表则拆出 TextBlock、ThinkingBlock、ToolUseBlock、ToolResultBlock，分别写入 `content`/`reasoning_content`/`tool_calls`/`tool_call_id` |
| 时间戳 | 由 `message.meta.timestamp`（float）转成 ISO 字符串写入 |
| UUID | 若 `meta.id` 为空则生成 shortuuid |

实际调用点在 `ReActAgent._save_message()`：`backend/engine/agent/react.py`。

### 2.2 读取逻辑

| 项目 | 内容 |
|---|---|
| 读取入口 | `ReActAgent._load_history()` |
| 文件路径 | `backend/engine/agent/react.py` |
| 查询方法 | `session_store.load_agent_messages(self.agent_id, source_id=source_id, limit=1000)` |
| 场景隔离 | 通过 `source_id` 过滤，SQL WHERE 增加 `AND source_id = ?` |
| 系统消息过滤 | 加载后过滤：`m.role != "system" or getattr(m.meta, "compressed", False)` |
| 排序 | DB 内 `ORDER BY id DESC LIMIT 1000`，取出后 `reversed(rows)` 恢复时间升序 |
| 内存状态 | `_messages` 按 `source_id` 隔离；切换 `source_id` 时 `clear()` 并重新加载 |

### 2.3 全量还是部分？

| 层级 | 存储位置 | 说明 |
|---|---|---|
| DB | **全量持久化** | `agent_messages` 不主动删除原始消息，除非压缩 Worker 显式调用 `delete_agent_messages_by_uuids()` |
| 内存 | 当前场景的最近 N 条 | 受 `max_memory_messages`（默认 500）限制，超长时从头部截断；但 DB 里仍然全部保留 |

---

## 3. 记忆系统的存储

### 3.1 TopicCompressionMemory

| 数据类型 | 存储位置 | 说明 |
|---|---|---|
| 话题树状态（TopicContext） | `workspace/{agent_id}/memory.db` | SQLite，表 `state(key PRIMARY KEY, value TEXT)`，key=`topic_context`，值为 JSON |
| 压缩后的话题摘要 | `workspace/{agent_id}/_compressed/*.md` | Markdown 文件，包含 YAML frontmatter + `## Summary` 正文 |
| 压缩失败重试标记 | `workspace/{agent_id}/_compressed/*.zvec_failed` | Worker 在 zvec 索引失败时生成，启动时重试 |
| 实现文件 | `backend/engine/memory/topic_compression/topic_memory.py` | |

### 3.2 Zvec 向量索引

| 项目 | 内容 |
|---|---|
| 根目录 | `~/.cloudmind-zome/zvec` |
| 消息向量库 | `~/.cloudmind-zome/zvec/agent_memory` |
| 话题向量库 | `~/.cloudmind-zome/zvec/agent_topics` |
| 底层实现 | Alibaba zvec（C++ HNSW） |
| 存储方式 | **本地文件持久化**，非内存 |
| schema 字段 | `message_id`, `agent_id`, `text`, `role`, `source`, `source_id`, `source_name`, `timestamp`, `embedding` |
| 定义文件 | `backend/engine/context/vector_store.py` |

说明：
- 首次 `add()` 时根据 embedding 维度自动建 collection；schema 老旧时会自动重建。
- 删除 Agent 记忆时通过 `delete_by_filter(agent_id == "...")` 删除对应 doc。

### 3.3 嵌入缓存

| 项目 | 现状 |
|---|---|
| 是否有本地缓存 | **没有** |
| Embedder 实现 | `backend/engine/context/embedder.py` |
| 行为 | 每次调用 `embed()` / `embed_single()` 都通过 HTTP 请求 embedding provider（SiliconFlow 等），无磁盘或内存缓存 |
| 相关但非嵌入缓存 | `ToolResultPruner` 会把超大 tool result 存到 `workspace/{agent_id}/tool_results_cache/*.md`，这与 embedding 无关 |

---

## 4. Tauri 桌面模式下的路径问题

### 4.1 当前路径行为

| 路径变量 | 当前值 | 所在文件 |
|---|---|---|
| `DATA_DIR` | `Path.home() / ".cloudmind-zome"` | `backend/app/database.py:22` |
| `DB_PATH` | `~/.cloudmind-zome/cloudmind.db` | `backend/app/database.py:24` |
| `UPLOAD_DIR` | `~/.cloudmind-zome/uploads` | `backend/app/main.py:234` |
| `userdata` | `~/.cloudmind-zome/userdata` | `backend/app/api/auth.py:19` |
| zvec 向量库 | `~/.cloudmind-zome/zvec` | `backend/engine/context/vector_store.py:19` |
| `WORKSPACE_ROOT` | 项目根目录下的 `workspace/` | `backend/app/database.py:28` |

`Path.home()` 在 Tauri 打包后仍然是 **操作系统当前用户的家目录**：
- Windows: `C:\Users\<用户名>\.cloudmind-zome`
- macOS: `/Users/<用户名>/.cloudmind-zome`
- Linux: `/home/<用户名>/.cloudmind-zome`

### 4.2 数据是否都在 `~/.cloudmind-zome`？

| 数据 | 路径 |
|---|---|
| SQLite 主数据库 | `~/.cloudmind-zome/cloudmind.db` |
| 上传文件 | `~/.cloudmind-zome/uploads` |
| 用户档案 | `~/.cloudmind-zome/userdata/profile.md` |
| zvec 向量索引 | `~/.cloudmind-zome/zvec` |
| Agent 工作区（SOUL.md / AGENT.md / MEMORY.md / 代码） | **不在 `~/.cloudmind-zome`**，在 `项目根目录/workspace/` |
| TopicCompression 状态/摘要 | **不在 `~/.cloudmind-zome`**，在 `workspace/{agent_id}/memory.db` 和 `_compressed/*.md` |
| Tool result 大内容缓存 | **不在 `~/.cloudmind-zome`**，在 `workspace/{agent_id}/tool_results_cache/` |

### 4.3 有没有办法把数据改到 Tauri App 目录？

**当前代码里没有提供配置项。**

- `DATA_DIR`、`WORKSPACE_ROOT` 都是硬编码，没有读取环境变量或配置文件来覆盖。
- `backend/engine/config/loader.py` 支持 `${VAR}` 环境变量替换，但只用于 `backend/engine/config.yaml` 里的字段；`config/models.py` 的 `AppConfig` 没有 `data_dir` 或 `workspace_root` 字段。
- `frontend/src-tauri/src/main.rs` 启动 Python 时没有设置 `HOME`、`CLOUDMIND_DATA_DIR` 之类的环境变量。
- Tauri 的 `app_data_dir()`（如 `%APPDATA%\com.cloudmind.zome`）当前**完全没有被使用**。

因此：
- 无法通过用户配置把 `~/.cloudmind-zome` 改到 Tauri App 数据目录。
- 如果一定要改，需要改代码（如让 `DATA_DIR` 读取环境变量），但这不是当前现状。

### 4.4 `WORKSPACE_ROOT` 的潜在风险

`WORKSPACE_ROOT = Path(__file__).resolve().parent.parent.parent / "workspace"`：

- **开发模式**：backend 源码在 `项目根目录/backend`，所以 `WORKSPACE_ROOT` 指向 `项目根目录/workspace`，符合预期。
- **Tauri 打包后**：如果后端以源码形式随包分发且 `__file__` 位置不变，仍然指向包内或包外相对位置；如果未来把 backend 单独打包/签名，`__file__` 的位置可能变化，导致 `workspace/` 指向不可预期的目录。
- 目前没有任何运行时参数可以把 `WORKSPACE_ROOT` 指向 Tauri 的 app data dir。
