# Unified Memory Pool Design

## 1. Table Schema

```sql
CREATE TABLE agent_messages (
    id          TEXT PRIMARY KEY,
    agent_id    TEXT NOT NULL,
    role        TEXT NOT NULL,  -- user | assistant | system | tool
    content     TEXT NOT NULL,
    source      TEXT NOT NULL,  -- private | group | workflow
    source_id   TEXT NOT NULL,  -- session_id / action_run_id
    source_name TEXT NOT NULL,  -- display name of the scene
    sender_id   TEXT,
    sender_name TEXT,
    timestamp   DATETIME DEFAULT CURRENT_TIMESTAMP,
    metadata    JSON           -- extra: batch_id, tool_call_id, etc.
);

CREATE INDEX idx_agent_messages_agent ON agent_messages(agent_id);
CREATE INDEX idx_agent_messages_source ON agent_messages(agent_id, source);
CREATE INDEX idx_agent_messages_time ON agent_messages(timestamp);
```

## 2. Load Strategy

When Worker starts a new Job:

1. Load recent N messages (default 20) across ALL scenes for this Agent
2. If token budget allows, load more history
3. If current scene has messages within last 10 minutes, prioritize them
4. Sort by timestamp ascending

```python
async def load_history(agent_id: str, current_source: str, limit: int = 20):
    # 1. Recent messages from current scene (last 10 min)
    recent = await db.execute(
        select(AgentMessage)
        .where(agent_id=agent_id, source=current_source)
        .where(timestamp > now - 10min)
        .order_by(timestamp.desc())
        .limit(limit)
    )
    # 2. Fill remaining with global recent messages
    # 3. Return unified list sorted by timestamp
```

## 3. Cross-Scene Recall

Agent can reference group chat content during private chat.

**Implementation**: Provide a tool `recall_memory`:

```python
@tool
async def recall_memory(query: str, source: str = "any", limit: int = 5) -> str:
    """Retrieve historical messages from unified memory pool.
    source: any | private | group | workflow
    """
    stmt = select(AgentMessage).where(agent_id=current_agent_id)
    if source != "any":
        stmt = stmt.where(AgentMessage.source == source)
    # Vector search or full-text search (MVP: LIKE %%)
    ...
```

**System prompt hint**:
```
你可以随时调用 recall_memory 工具来检索你的历史记忆。
```

## 4. Context Injection Format

Messages are injected into LLM context with source annotation:

```json
[
  {"role": "system", "content": "人格 Prompt + 当前场景"},
  {"role": "user", "content": "昨天方案怎么样了？", "meta": {"source": "private", "source_name": "与调度员的私聊"}},
  {"role": "assistant", "content": "我觉得可行...", "meta": {"source": "private", "source_name": "与调度员的私聊"}},
  {"role": "user", "content": "大家怎么看？", "meta": {"source": "group", "source_name": "技术交流群"}},
  ...
]
```

LLM sees the source implicitly through the conversation flow. For explicit recall, use the `recall_memory` tool.

## 5. Migration from Session-Isolated Storage

Current `session_store` uses `session_id` as key.

Migration path:
1. Keep old `session_messages` table for backward compatibility
2. Create new `agent_messages` table
3. Worker writes to `agent_messages` only
4. Old data can be imported later (V1.2)
