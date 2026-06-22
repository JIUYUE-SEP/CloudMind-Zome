# Per-Agent 物理隔离文档型存储架构设计

## 日期：2026-06-22

---

## 背景

当前架构中，Agent 数据部分存储在共享数据库 `cloudmind.db` 中（如 `chat_messages`、`agents` 表），部分存储在 Agent 独立目录中（如 `workspace/{agent_id}/agent.db`、zvec、Markdown 文件）。

目标：实现**完全物理隔离**的文档型存储，每个 Agent 的所有数据存放在各自的 workplace，原始数据为人类可读的文档格式，辅助索引可重建。

---

## 核心原则

1. **物理隔离**：每个 Agent 的数据完全独立，删除 `workspace/{agent_id}/` 即彻底删除该 Agent 的所有数据
2. **文档型存储**：原始数据必须为人类可读的文本格式（Markdown、JSON、JSON Lines），可版本控制
3. **辅助索引可选**：允许生成辅助索引文件（如全文搜索索引、向量索引），但必须能从原始文档重建
4. **无共享数据库**：不存在所有 Agent 共享的数据库文件

---

## 目录结构

```
workspace/{agent_id}/
├── AGENTS.md              # 工作规范（文档型）
├── IDENTITY.md            # 身份核心（文档型）
├── USER.md                # 眼中的用户（文档型）
├── SOUL.md                # 灵魂内核（文档型）
├── MEMORY.md              # 长期记忆（文档型）
├── HEARTBEAT.md           # 心跳任务（文档型）
├── PROFILE.md             # 对外资料（文档型）
├── memory/                # 每日笔记
│   └── 2024-01-15.md
├── skills/                # 自定义技能
│   └── coding/
│       └── SKILL.md
├── data/                  # 结构化数据（文档型）
│   ├── config.json        # Agent 配置（JSON）
│   ├── sessions.jsonl     # 会话元数据（JSON Lines）
│   ├── messages/          # 消息（按会话分文件，JSON Lines）
│   │   ├── session_001.jsonl
│   │   └── session_002.jsonl
│   └── memories.jsonl     # 跨场景记忆（JSON Lines）
├── index/                 # 辅助索引（可重建）
│   ├── fts/               # 全文搜索索引
│   └── vector/            # 向量索引（zvec 或 faiss）
└── attachments/           # 附件（上传文件）
    └── uploads/
```

---

## 数据格式规范

### 1. 配置（config.json）

```json
{
  "id": "uuid",
  "name": "Agent名称",
  "codename": "代号",
  "capabilities": ["coding", "writing"],
  "provider_id": "openai",
  "model_id": "gpt-4",
  "temperature": 0.7,
  "top_p": 1.0,
  "max_context_tokens": 8192,
  "represent_color": "#00e5c9",
  "portrait_url": "/uploads/portraits/xxx.png",
  "created_at": "2024-01-15T10:00:00Z",
  "updated_at": "2024-01-15T10:00:00Z",
  "status": "active",
  "role": "member",
  "daily_token_limit": 100000,
  "timeout_seconds": 300,
  "semantic_search_enabled": true,
  "image_generation_enabled": false,
  "topic_compression_enabled": true
}
```

### 2. 消息（*.jsonl）

每行一个 JSON 对象：

```json
{"id": "msg_001", "session_id": "sess_001", "sender_id": "user", "sender_type": "user", "content": "你好", "content_type": "text", "reply_to": null, "tool_calls": null, "reasoning": null, "created_at": "2024-01-15T10:00:00Z", "client_msg_id": null, "batch_id": null}
```

```json
{"id": "msg_002", "session_id": "sess_001", "sender_id": "agent_001", "sender_type": "agent", "content": "你好！有什么可以帮你的？", "content_type": "text", "reply_to": "msg_001", "tool_calls": null, "reasoning": "用户打招呼，我应当友好回应", "created_at": "2024-01-15T10:00:05Z", "client_msg_id": null, "batch_id": null}
```

### 3. 会话元数据（sessions.jsonl）

```json
{"id": "sess_001", "type": "private", "owner_id": "user", "conductor_agent_id": null, "status": "active", "last_message_at": "2024-01-15T10:00:05Z", "created_at": "2024-01-15T10:00:00Z"}
```

### 4. 跨场景记忆（memories.jsonl）

```json
{"id": "mem_001", "agent_id": "agent_001", "role": "assistant", "content": "用户喜欢简洁回答", "source": "private", "source_id": "sess_001", "source_name": "初次对话", "sender_id": "user", "sender_name": "张三", "timestamp": "2024-01-15T10:00:00Z", "round": 1, "compressed": false, "message_uuid": "uuid"}
```

---

## 查询策略

### 简单查询（直接读文件）

```python
import json

def get_session_messages(agent_id, session_id):
    """直接遍历 JSON Lines 文件"""
    path = WORKSPACE_ROOT / agent_id / "data" / "messages" / f"{session_id}.jsonl"
    messages = []
    with open(path) as f:
        for line in f:
            msg = json.loads(line)
            messages.append(msg)
    return messages
```

### 复杂查询（DuckDB 内存模式）

```python
import duckdb

class AgentDataStore:
    def __init__(self, agent_id):
        self.agent_id = agent_id
        self.data_dir = WORKSPACE_ROOT / agent_id / "data"
        self._conn = None
    
    @property
    def conn(self):
        if self._conn is None:
            self._conn = duckdb.connect()  # 纯内存，不产生文件
            # 注册视图，指向 jsonl 文件
            messages_path = self.data_dir / "messages" / "*.jsonl"
            if messages_path.parent.exists():
                self._conn.execute(f"""
                    CREATE VIEW messages AS 
                    SELECT * FROM read_json_auto('{messages_path}')
                """)
            memories_path = self.data_dir / "memories.jsonl"
            if memories_path.exists():
                self._conn.execute(f"""
                    CREATE VIEW memories AS 
                    SELECT * FROM read_json_auto('{memories_path}')
                """)
        return self._conn
    
    def query_messages(self, session_id, limit=100):
        return self.conn.execute(
            "SELECT * FROM messages WHERE session_id = ? ORDER BY created_at LIMIT ?",
            [session_id, limit]
        ).fetchall()
    
    def search_memories(self, keyword):
        """全文搜索记忆"""
        return self.conn.execute(
            "SELECT * FROM memories WHERE content LIKE ?",
            [f"%{keyword}%"]
        ).fetchall()
    
    def close(self):
        if self._conn:
            self._conn.close()
            self._conn = None
```

---

## 迁移路径（从当前架构）

### Phase 1：Agent 配置迁移
- 将 `cloudmind.db` 的 `agents` 表数据导出为 `workspace/{agent_id}/config.json`
- 修改 `Agent` 模型读取逻辑，优先从 `config.json` 读取

### Phase 2：消息数据迁移
- 将 `cloudmind.db` 的 `chat_messages` 按 `session_id` 分文件导出为 `workspace/{agent_id}/data/messages/*.jsonl`
- 将 `chat_sessions` 导出为 `workspace/{agent_id}/data/sessions.jsonl`

### Phase 3：LLM 会话迁移
- 将 `workspace/{agent_id}/agent.db` 的 `llm_sessions`、`llm_messages` 导出为 JSON Lines
- 保留 `agent.db` 或完全替换为文档存储

### Phase 4：辅助索引重建
- 向量索引：从 `messages/*.jsonl` 和 `memories.jsonl` 重新计算嵌入
- 全文搜索索引：从 JSON Lines 重建

---

## 备份与恢复

### 备份单个 Agent

```bash
# 复制整个 workplace
tar czf agent_001_backup.tar.gz workspace/agent_001/

# 或 rsync 到远程
rsync -av workspace/agent_001/ backup-server:/backups/agent_001/
```

### 恢复单个 Agent

```bash
# 解压到 workplace
tar xzf agent_001_backup.tar.gz -C workspace/

# 启动后自动重建辅助索引
```

### 删除单个 Agent

```bash
rm -rf workspace/agent_001/
# 所有数据彻底消失，包括配置、消息、记忆、索引
```

---

## 与现有系统的对比

| 维度 | 当前架构 | 新架构 |
|------|---------|--------|
| Agent 配置 | `cloudmind.db` 共享表 | `workspace/{id}/config.json` |
| 聊天消息 | `cloudmind.db` 共享表 | `workspace/{id}/data/messages/*.jsonl` |
| LLM 会话 | `agent.db` 私有 SQLite | `workspace/{id}/data/llm_sessions.jsonl` |
| LLM 消息 | `agent.db` 私有 SQLite | `workspace/{id}/data/llm_messages.jsonl` |
| 跨场景记忆 | `agent.db` 私有 SQLite | `workspace/{id}/data/memories.jsonl` |
| 工作区文件 | `workspace/{id}/*.md` | 保持不变 |
| 向量索引 | `workspace/{id}/zvec/` | 保持不变或迁移到 `index/vector/` |
| 物理隔离 | 部分（DB 共享） | 完全（所有数据在 workplace） |
| 人类可读 | 部分（DB 不可读） | 完全（所有原始数据是文本） |
| 查询性能 | SQL 索引快 | 简单查询快，复杂查询需 DuckDB |
| 备份粒度 | 整库备份 | 单个 Agent 备份 |
| 版本控制 | DB 不可版本控制 | JSONL/Markdown 可版本控制 |

---

## 验收标准

- [ ] 每个 Agent 的所有数据存放在 `workspace/{agent_id}/` 下
- [ ] 原始数据为文档型格式（Markdown、JSON、JSON Lines）
- [ ] 不存在所有 Agent 共享的数据库文件
- [ ] 辅助索引（如有）可从原始文档重建
- [ ] 删除 `workspace/{agent_id}/` 即彻底删除该 Agent 的所有数据
- [ ] 可通过文件系统工具（cp、rsync、tar）备份和恢复单个 Agent
- [ ] 查询性能可接受（简单查询 < 100ms，复杂查询 < 1s）

---

## 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| JSON Lines 文件过大（>100MB） | 查询变慢 | 按时间分片（messages/2024-01.jsonl） |
| 并发写入同一文件 | 数据损坏 | 文件级锁或按会话分文件 |
| DuckDB 内存占用 | 多 Agent 时内存增长 | 懒加载 + 超时关闭 |
| 迁移数据丢失 | 高 | 迁移前完整备份，验证后删除旧数据 |

