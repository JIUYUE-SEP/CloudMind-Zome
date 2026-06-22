# Per-Agent 文档型存储架构实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Agent 数据从共享数据库迁移到完全物理隔离的文档型存储，每个 Agent 的所有数据存放在各自的 workplace，原始数据为人类可读的文档格式。

**架构：** 删除共享 `cloudmind.db` 中的 Agent 相关表，将 Agent 配置、消息、记忆等数据全部存储为 `workspace/{agent_id}/` 下的 JSON/JSON Lines/Markdown 文件。辅助索引（向量、全文搜索）可重建，不依赖原始数据。

**Tech Stack:** Python, FastAPI, JSON Lines, Markdown, DuckDB (内存模式，可选), zvec (向量索引)

---

## 重要前提

- **旧数据全部清除，不需要迁移**
- 这是一个破坏性变更，实施后所有现有 Agent 数据将丢失（已确认接受）
- 实施后 `cloudmind.db` 只保留平台级数据（用户设置、提供商配置等）

---

## 文件结构映射

| 当前 | 新位置 | 格式 |
|------|--------|------|
| `cloudmind.db` → `agents` 表 | `workspace/{id}/config.json` | JSON |
| `cloudmind.db` → `chat_messages` | `workspace/{id}/data/messages/{session_id}.jsonl` | JSON Lines |
| `cloudmind.db` → `chat_sessions` | `workspace/{id}/data/sessions.jsonl` | JSON Lines |
| `cloudmind.db` → `chat_session_members` | `workspace/{id}/data/session_members.jsonl` | JSON Lines |
| `agent.db` → `llm_sessions` | `workspace/{id}/data/llm_sessions.jsonl` | JSON Lines |
| `agent.db` → `llm_messages` | `workspace/{id}/data/llm_messages.jsonl` | JSON Lines |
| `agent.db` → `agent_messages` | `workspace/{id}/data/memories.jsonl` | JSON Lines |
| `workspace/{id}/*.md` | 保持不变 | Markdown |
| `workspace/{id}/zvec/` | 保持不变 或移到 `workspace/{id}/index/vector/` | 二进制索引 |

---

## Task 1: 创建 Agent 文档型数据访问层

**Files:**
- Create: `backend/engine/agent/data_store.py`

**说明:** 这是核心数据访问层，封装所有 Agent 数据的读写操作。其他模块不直接操作文件，而是通过此层访问。

- [ ] **Step 1: 创建 AgentDataStore 类骨架**

```python
"""Agent document-based data store.

All agent data is stored in workspace/{agent_id}/ as human-readable documents:
- config.json: agent configuration
- data/sessions.jsonl: chat session metadata
- data/messages/{session_id}.jsonl: messages per session
- data/llm_sessions.jsonl: LLM session records
- data/llm_messages.jsonl: LLM messages
- data/memories.jsonl: cross-scene memory pool
- *.md files: workspace documents (SOUL, IDENTITY, USER, etc.)

No shared database. All data is per-agent and file-based.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, Optional

logger = logging.getLogger(__name__)


class AgentDataStore:
    """Read/write helper for a single agent's document-based data."""

    def __init__(self, agent_id: str, workspace_root: Path | str | None = None):
        self.agent_id = agent_id
        if workspace_root is None:
            try:
                from app.database import WORKSPACE_ROOT
            except ImportError:
                WORKSPACE_ROOT = Path.home() / ".cloudmind-zome" / "workspace"
            workspace_root = WORKSPACE_ROOT
        self.workspace_root = Path(workspace_root)
        self.agent_dir = self.workspace_root / agent_id
        self.data_dir = self.agent_dir / "data"
        self.messages_dir = self.data_dir / "messages"

    # ------------------------------------------------------------------
    # Paths
    # ------------------------------------------------------------------

    @property
    def config_path(self) -> Path:
        return self.agent_dir / "config.json"

    @property
    def sessions_path(self) -> Path:
        return self.data_dir / "sessions.jsonl"

    @property
    def memories_path(self) -> Path:
        return self.data_dir / "memories.jsonl"

    @property
    def llm_sessions_path(self) -> Path:
        return self.data_dir / "llm_sessions.jsonl"

    @property
    def llm_messages_path(self) -> Path:
        return self.data_dir / "llm_messages.jsonl"

    def message_path(self, session_id: str) -> Path:
        return self.messages_dir / f"{session_id}.jsonl"

    # ------------------------------------------------------------------
    # Directory helpers
    # ------------------------------------------------------------------

    def ensure_dirs(self) -> None:
        """Create all necessary directories."""
        self.agent_dir.mkdir(parents=True, exist_ok=True)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.messages_dir.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------
    # Config (JSON)
    # ------------------------------------------------------------------

    def read_config(self) -> dict[str, Any] | None:
        """Read agent configuration from config.json."""
        if not self.config_path.exists():
            return None
        try:
            with self.config_path.open("r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as exc:
            logger.warning("Failed to read config for %s: %s", self.agent_id, exc)
            return None

    def write_config(self, config: dict[str, Any]) -> None:
        """Write agent configuration to config.json."""
        self.ensure_dirs()
        with self.config_path.open("w", encoding="utf-8") as f:
            json.dump(config, f, ensure_ascii=False, indent=2)

    def update_config(self, updates: dict[str, Any]) -> dict[str, Any] | None:
        """Partial update config."""
        config = self.read_config() or {}
        config.update(updates)
        config["updated_at"] = datetime.now(timezone.utc).isoformat()
        self.write_config(config)
        return config

    # ------------------------------------------------------------------
    # JSON Lines helpers
    # ------------------------------------------------------------------

    def _append_jsonl(self, path: Path, record: dict[str, Any]) -> None:
        """Append a single record to a JSON Lines file."""
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False, default=str) + "\n")

    def _read_jsonl(self, path: Path) -> Iterator[dict[str, Any]]:
        """Read all records from a JSON Lines file."""
        if not path.exists():
            return
        with path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        yield json.loads(line)
                    except json.JSONDecodeError as exc:
                        logger.warning("Invalid JSON line in %s: %s", path, exc)

    def _read_jsonl_filtered(
        self, path: Path, **filters: Any
    ) -> Iterator[dict[str, Any]]:
        """Read records matching filters."""
        for record in self._read_jsonl(path):
            if all(record.get(k) == v for k, v in filters.items()):
                yield record

    # ------------------------------------------------------------------
    # Sessions
    # ------------------------------------------------------------------

    def create_session(self, session: dict[str, Any]) -> None:
        """Append a session record."""
        session.setdefault("created_at", datetime.now(timezone.utc).isoformat())
        self._append_jsonl(self.sessions_path, session)

    def get_sessions(self, **filters: Any) -> list[dict[str, Any]]:
        """Get sessions matching filters."""
        return list(self._read_jsonl_filtered(self.sessions_path, **filters))

    def get_session(self, session_id: str) -> dict[str, Any] | None:
        """Get a single session by ID."""
        for s in self._read_jsonl_filtered(self.sessions_path, id=session_id):
            return s
        return None

    # ------------------------------------------------------------------
    # Messages
    # ------------------------------------------------------------------

    def append_message(self, session_id: str, message: dict[str, Any]) -> None:
        """Append a message to a session's message file."""
        message.setdefault("created_at", datetime.now(timezone.utc).isoformat())
        self._append_jsonl(self.message_path(session_id), message)

    def get_messages(self, session_id: str) -> list[dict[str, Any]]:
        """Get all messages for a session."""
        return list(self._read_jsonl(self.message_path(session_id)))

    def get_messages_filtered(
        self, session_id: str, **filters: Any
    ) -> list[dict[str, Any]]:
        """Get messages matching filters."""
        return list(self._read_jsonl_filtered(self.message_path(session_id), **filters))

    # ------------------------------------------------------------------
    # Memories (cross-scene)
    # ------------------------------------------------------------------

    def append_memory(self, memory: dict[str, Any]) -> None:
        """Append a memory record."""
        memory.setdefault("timestamp", datetime.now(timezone.utc).isoformat())
        self._append_jsonl(self.memories_path, memory)

    def get_memories(self, **filters: Any) -> list[dict[str, Any]]:
        """Get memories matching filters."""
        return list(self._read_jsonl_filtered(self.memories_path, **filters))

    # ------------------------------------------------------------------
    # LLM Sessions
    # ------------------------------------------------------------------

    def append_llm_session(self, session: dict[str, Any]) -> None:
        self._append_jsonl(self.llm_sessions_path, session)

    def get_llm_sessions(self, **filters: Any) -> list[dict[str, Any]]:
        return list(self._read_jsonl_filtered(self.llm_sessions_path, **filters))

    # ------------------------------------------------------------------
    # LLM Messages
    # ------------------------------------------------------------------

    def append_llm_message(self, message: dict[str, Any]) -> None:
        self._append_jsonl(self.llm_messages_path, message)

    def get_llm_messages(self, session_id: str) -> list[dict[str, Any]]:
        return list(
            self._read_jsonl_filtered(self.llm_messages_path, session_id=session_id)
        )

    # ------------------------------------------------------------------
    # Delete agent
    # ------------------------------------------------------------------

    def delete_all(self) -> None:
        """Delete all agent data."""
        import shutil

        if self.agent_dir.exists():
            shutil.rmtree(self.agent_dir)
            logger.info("Deleted all data for agent %s", self.agent_id)
```

- [ ] **Step 2: 写基础测试**

```python
# tests/engine/agent/test_data_store.py
import shutil
import tempfile
from pathlib import Path

import pytest

from engine.agent.data_store import AgentDataStore


@pytest.fixture
def temp_workspace():
    tmp = tempfile.mkdtemp()
    yield Path(tmp)
    shutil.rmtree(tmp, ignore_errors=True)


class TestAgentDataStore:
    def test_create_and_read_config(self, temp_workspace):
        store = AgentDataStore("agent_001", workspace_root=temp_workspace)
        config = {
            "id": "agent_001",
            "name": "Test Agent",
            "provider_id": "openai",
            "model_id": "gpt-4",
        }
        store.write_config(config)

        read = store.read_config()
        assert read["name"] == "Test Agent"
        assert read["provider_id"] == "openai"

    def test_update_config(self, temp_workspace):
        store = AgentDataStore("agent_001", workspace_root=temp_workspace)
        store.write_config({"name": "Old"})
        store.update_config({"name": "New", "temperature": 0.5})

        config = store.read_config()
        assert config["name"] == "New"
        assert config["temperature"] == 0.5

    def test_append_and_read_messages(self, temp_workspace):
        store = AgentDataStore("agent_001", workspace_root=temp_workspace)
        store.append_message("sess_001", {"id": "msg_1", "content": "Hello"})
        store.append_message("sess_001", {"id": "msg_2", "content": "World"})

        messages = store.get_messages("sess_001")
        assert len(messages) == 2
        assert messages[0]["content"] == "Hello"
        assert messages[1]["content"] == "World"

    def test_sessions(self, temp_workspace):
        store = AgentDataStore("agent_001", workspace_root=temp_workspace)
        store.create_session({"id": "sess_001", "type": "private"})
        store.create_session({"id": "sess_002", "type": "group"})

        sessions = store.get_sessions(type="private")
        assert len(sessions) == 1
        assert sessions[0]["id"] == "sess_001"

    def test_memories(self, temp_workspace):
        store = AgentDataStore("agent_001", workspace_root=temp_workspace)
        store.append_memory({"id": "mem_1", "content": "User likes tea"})
        store.append_memory({"id": "mem_2", "content": "User hates coffee"})

        memories = store.get_memories()
        assert len(memories) == 2

    def test_delete_all(self, temp_workspace):
        store = AgentDataStore("agent_001", workspace_root=temp_workspace)
        store.write_config({"name": "Test"})
        store.delete_all()
        assert not store.agent_dir.exists()
```

- [ ] **Step 3: 运行测试**

```bash
cd backend
pytest tests/engine/agent/test_data_store.py -v
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add backend/engine/agent/data_store.py tests/engine/agent/test_data_store.py
git commit -m "feat(agent): add document-based data store for per-agent storage"
```

---

## Task 2: 修改 Agent 创建 API，使用文档型配置

**Files:**
- Modify: `backend/app/api/agents.py`

**说明:** 创建 Agent 时不再写入 `cloudmind.db` 的 `agents` 表，而是写入 `workspace/{id}/config.json`。

- [ ] **Step 1: 修改 create_agent 函数**

```python
# In backend/app/api/agents.py

from engine.agent.data_store import AgentDataStore

@router.post("", response_model=ListResp)
async def create_agent(
    body: AgentCreate,
    db: AsyncSession = Depends(get_db),
):
    # Validate: embedder is required
    if not body.embedder_provider_id or not body.embedder_model_id:
        raise HTTPException(status_code=400, detail="Embedder provider and model are required")

    existing = await db.execute(select(Agent.codename))
    codenames = [r for r in existing.scalars().all()]
    codename = _gen_codename(codenames)

    agent_id = str(uuid.uuid4())
    
    # Create agent config as JSON document
    config = {
        "id": agent_id,
        "name": body.name,
        "codename": codename,
        "capabilities": body.capabilities or [],
        "aliases": body.aliases or [],
        "tags": body.tags or [],
        "represent_color": body.represent_color,
        "allowed_paths": body.allowed_paths or [],
        "toolsets": body.toolsets or [],
        "enabled_skills": body.enabled_skills or [],
        "provider_id": body.provider_id,
        "model_id": body.model_id,
        "temperature": body.temperature,
        "top_p": body.top_p,
        "marker_provider_id": body.marker_provider_id,
        "marker_model_id": body.marker_model_id,
        "embedder_provider_id": body.embedder_provider_id,
        "embedder_model_id": body.embedder_model_id,
        "compressor_provider_id": body.compressor_provider_id,
        "compressor_model_id": body.compressor_model_id,
        "imagegen_provider_id": body.imagegen_provider_id,
        "imagegen_model_id": body.imagegen_model_id,
        "fallback_chain": body.fallback_chain or [],
        "personality": body.personality or {},
        "max_context_tokens": body.max_context_tokens,
        "status": "active",
        "role": "member",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    
    # Write to document store
    store = AgentDataStore(agent_id)
    store.ensure_dirs()
    store.write_config(config)

    # Initialize workspace files (markdown)
    try:
        MindWorkspace(agent_id).ensure_agent_workspace()
    except Exception as exc:
        logger.warning("Failed to initialize workspace for agent %s: %s", agent_id, exc)

    # Copy user profile.md to agent's USER.md as initial content
    try:
        profile_path = DATA_DIR / "userdata" / "profile.md"
        if profile_path.exists():
            workspace = MindWorkspace(agent_id)
            user_md_path = workspace.path("USER.md")
            profile_content = profile_path.read_text(encoding="utf-8")
            if profile_content.strip():
                user_md_path.write_text(profile_content, encoding="utf-8")
                logger.info("Copied profile.md to USER.md for agent %s", agent_id)
    except Exception as exc:
        logger.warning("Failed to copy profile.md to USER.md for agent %s: %s", agent_id, exc)

    return ListResp(data={
        "id": agent_id,
        "name": config["name"],
        "codename": config["codename"],
        "created_at": config["created_at"],
    })
```

- [ ] **Step 2: 修改 Agent 模型读取（get_agent / list_agents）**

```python
# Add helper to read from document store

def _load_agent_from_store(agent_id: str) -> dict[str, Any] | None:
    """Load agent config from document store."""
    store = AgentDataStore(agent_id)
    return store.read_config()


@router.get("/{agent_id}", response_model=ListResp)
async def get_agent(agent_id: str, db: AsyncSession = Depends(get_db)):
    config = _load_agent_from_store(agent_id)
    if not config:
        raise HTTPException(status_code=404, detail="Agent not found")
    return ListResp(data=config)


@router.get("", response_model=ListResp)
async def list_agents(
    db: AsyncSession = Depends(get_db),
    status: Optional[str] = Query(None),
    role: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    sort_by: str = Query("created_at"),
    sort_order: str = Query("desc"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
):
    # Scan workspace directories
    agents = []
    if WORKSPACE_ROOT.exists():
        for agent_dir in WORKSPACE_ROOT.iterdir():
            if agent_dir.is_dir():
                store = AgentDataStore(agent_dir.name)
                config = store.read_config()
                if config:
                    # Apply filters
                    if status and config.get("status") != status:
                        continue
                    if role and config.get("role") != role:
                        continue
                    if search and search.lower() not in config.get("name", "").lower():
                        continue
                    agents.append(config)
    
    # Sort
    reverse = sort_order == "desc"
    agents.sort(key=lambda x: x.get(sort_by, ""), reverse=reverse)
    
    # Paginate
    total = len(agents)
    start = (page - 1) * page_size
    end = start + page_size
    
    return ListResp(data={
        "items": agents[start:end],
        "total": total,
        "page": page,
        "page_size": page_size,
    })
```

- [ ] **Step 3: 修改 update_agent 和 delete_agent**

```python
@router.put("/{agent_id}", response_model=ListResp)
async def update_agent(
    agent_id: str,
    body: AgentUpdate,
    db: AsyncSession = Depends(get_db),
):
    store = AgentDataStore(agent_id)
    config = store.read_config()
    if not config:
        raise HTTPException(status_code=404, detail="Agent not found")
    
    updates = body.model_dump(exclude_unset=True)
    if "llm_config" in updates:
        updates["model_config"] = updates.pop("llm_config")
    
    store.update_config(updates)
    return ListResp(data={"id": agent_id, "updated": True})


@router.delete("/{agent_id}", response_model=ListResp)
async def delete_agent(
    agent_id: str,
    db: AsyncSession = Depends(get_db),
):
    store = AgentDataStore(agent_id)
    if not store.read_config():
        raise HTTPException(status_code=404, detail="Agent not found")
    
    store.delete_all()
    return ListResp(data={"id": agent_id, "deleted": True})
```

- [ ] **Step 4: 运行后端测试**

```bash
cd backend
pytest tests/app/api/test_agents.py -v -k "test_create_agent or test_get_agent or test_list_agents or test_update_agent or test_delete_agent"
```

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/agents.py
git commit -m "feat(api): migrate agent CRUD to document-based storage"
```

---

## Task 3: 修改 Chat API，使用文档型消息存储

**Files:**
- Modify: `backend/app/api/chat.py` (or wherever chat endpoints are)

**说明:** 将消息存储从 `cloudmind.db` 的 `chat_messages` 表改为 `workspace/{agent_id}/data/messages/{session_id}.jsonl`。

- [ ] **Step 1: 找到并读取 chat API 文件**

```bash
grep -r "chat_messages" backend/app/api/ --include="*.py" -l
```

- [ ] **Step 2: 修改消息发送/接收逻辑**

```python
# In the chat endpoint handler

from engine.agent.data_store import AgentDataStore

async def send_message(session_id: str, agent_id: str, content: str, ...):
    # Write message to agent's document store
    store = AgentDataStore(agent_id)
    
    message = {
        "id": str(uuid.uuid4()),
        "session_id": session_id,
        "sender_id": "user",
        "sender_type": "user",
        "content": content,
        "content_type": "text",
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    store.append_message(session_id, message)
    
    # ... rest of logic
```

- [ ] **Step 3: 修改消息读取逻辑**

```python
async def get_chat_history(session_id: str, agent_id: str):
    store = AgentDataStore(agent_id)
    return store.get_messages(session_id)
```

- [ ] **Step 4: Commit**

```bash
git add backend/app/api/chat.py
git commit -m "feat(api): migrate chat messages to document-based storage"
```

---

## Task 4: 修改 Engine 层，使用文档型 LLM/记忆存储

**Files:**
- Modify: `backend/engine/session/store.py`
- Modify: `backend/engine/agent/react.py` (where LLM calls are made)

**说明:** 将 `llm_sessions`、`llm_messages`、`agent_messages` 从 SQLite 改为 JSON Lines。

- [ ] **Step 1: 修改 SessionStore 类**

```python
# backend/engine/session/store.py

from engine.agent.data_store import AgentDataStore

class SessionStore:
    """Document-based session store."""
    
    def __init__(self, agent_id: str):
        self.agent_id = agent_id
        self.store = AgentDataStore(agent_id)
    
    def save_llm_session(self, session: dict[str, Any]) -> None:
        self.store.append_llm_session(session)
    
    def get_llm_sessions(self, **filters) -> list[dict[str, Any]]:
        return self.store.get_llm_sessions(**filters)
    
    def save_llm_message(self, message: dict[str, Any]) -> None:
        self.store.append_llm_message(message)
    
    def get_llm_messages(self, session_id: str) -> list[dict[str, Any]]:
        return self.store.get_llm_messages(session_id)
    
    def save_agent_message(self, message: dict[str, Any]) -> None:
        self.store.append_memory(message)
    
    def get_agent_messages(self, **filters) -> list[dict[str, Any]]:
        return self.store.get_memories(**filters)
```

- [ ] **Step 2: 修改 react.py 中的调用**

```python
# Where LLM calls are made, use the new document store
from engine.session.store import SessionStore

# Instead of writing to SQLite, write to JSON Lines
session_store = SessionStore(agent_id)
session_store.save_llm_message({...})
```

- [ ] **Step 3: Commit**

```bash
git add backend/engine/session/store.py backend/engine/agent/react.py
git commit -m "feat(engine): migrate LLM sessions and memories to document-based storage"
```

---

## Task 5: 清理共享数据库中的 Agent 相关表

**Files:**
- Modify: `backend/app/database.py`
- Modify: `backend/app/models/` (remove Agent model from SQLAlchemy)

**说明:** 从 `cloudmind.db` 中删除 `agents`、`chat_messages`、`chat_sessions`、`chat_session_members` 表。保留其他平台级表（providers、settings、users 等）。

- [ ] **Step 1: 修改 database.py，移除 Agent 表创建**

```python
# Remove Agent from the models that create tables
# Keep: providers, settings, users, etc.
```

- [ ] **Step 2: 删除或注释掉 Agent SQLAlchemy model**

```python
# backend/app/models/agents.py
# Either delete this file or keep it for reference but don't register it
```

- [ ] **Step 3: 创建数据库迁移脚本（或删除旧数据库）**

```bash
# Since old data is discarded, simplest approach:
rm ~/.cloudmind-zome/cloudmind.db
# Then restart app to create new schema without agent tables
```

- [ ] **Step 4: Commit**

```bash
git add backend/app/database.py backend/app/models/
git commit -m "refactor(db): remove agent tables from shared database"
```

---

## Task 6: 更新前端 API 调用

**Files:**
- Modify: `frontend/src/api/` (or wherever API calls are defined)

**说明:** 前端可能需要调整，因为后端 API 响应格式可能略有变化（如 `list_agents` 返回的数据结构）。

- [ ] **Step 1: 检查并更新 list_agents 响应处理**

```typescript
// If pagination structure changed
interface ListAgentsResponse {
  code: number
  data: {
    items: AgentConfig[]
    total: number
    page: number
    page_size: number
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/api/
git commit -m "feat(frontend): update API types for document-based agent storage"
```

---

## Task 7: 端到端测试

**Files:**
- Create: `tests/e2e/test_agent_lifecycle.py`

- [ ] **Step 1: 创建端到端测试**

```python
import pytest
import requests

API_BASE = "http://localhost:8000"

class TestAgentLifecycle:
    def test_create_agent(self):
        resp = requests.post(f"{API_BASE}/agents", json={
            "name": "Test Agent",
            "provider_id": "openai",
            "model_id": "gpt-4",
            "embedder_provider_id": "openai",
            "embedder_model_id": "text-embedding-3-small",
        })
        assert resp.status_code == 200
        data = resp.json()["data"]
        assert "id" in data
        assert data["name"] == "Test Agent"
        return data["id"]

    def test_get_agent(self):
        agent_id = self.test_create_agent()
        resp = requests.get(f"{API_BASE}/agents/{agent_id}")
        assert resp.status_code == 200
        data = resp.json()["data"]
        assert data["id"] == agent_id

    def test_list_agents(self):
        resp = requests.get(f"{API_BASE}/agents")
        assert resp.status_code == 200
        data = resp.json()["data"]
        assert "items" in data
        assert "total" in data

    def test_update_agent(self):
        agent_id = self.test_create_agent()
        resp = requests.put(f"{API_BASE}/agents/{agent_id}", json={
            "name": "Updated Name",
        })
        assert resp.status_code == 200

    def test_delete_agent(self):
        agent_id = self.test_create_agent()
        resp = requests.delete(f"{API_BASE}/agents/{agent_id}")
        assert resp.status_code == 200
        
        # Verify agent is gone
        resp = requests.get(f"{API_BASE}/agents/{agent_id}")
        assert resp.status_code == 404

    def test_agent_data_isolation(self):
        # Create two agents
        resp1 = requests.post(f"{API_BASE}/agents", json={
            "name": "Agent A",
            "provider_id": "openai",
            "model_id": "gpt-4",
            "embedder_provider_id": "openai",
            "embedder_model_id": "text-embedding-3-small",
        })
        resp2 = requests.post(f"{API_BASE}/agents", json={
            "name": "Agent B",
            "provider_id": "openai",
            "model_id": "gpt-4",
            "embedder_provider_id": "openai",
            "embedder_model_id": "text-embedding-3-small",
        })
        
        id_a = resp1.json()["data"]["id"]
        id_b = resp2.json()["data"]["id"]
        
        # Verify they have separate workspace directories
        import os
        from pathlib import Path
        workspace = Path.home() / ".cloudmind-zome" / "workspace"
        assert (workspace / id_a / "config.json").exists()
        assert (workspace / id_b / "config.json").exists()
        
        # Delete A, verify B still exists
        requests.delete(f"{API_BASE}/agents/{id_a}")
        assert not (workspace / id_a).exists()
        assert (workspace / id_b).exists()
```

- [ ] **Step 2: 运行端到端测试**

```bash
# Start backend
python -m backend.app.main

# Run tests
pytest tests/e2e/test_agent_lifecycle.py -v
```

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/test_agent_lifecycle.py
git commit -m "test(e2e): add agent lifecycle tests for document-based storage"
```

---

## 验收清单

- [ ] `AgentDataStore` 类实现完整，测试通过
- [ ] 创建 Agent 时写入 `workspace/{id}/config.json`
- [ ] 消息存储到 `workspace/{id}/data/messages/{session_id}.jsonl`
- [ ] LLM 会话/消息存储到 `workspace/{id}/data/llm_*.jsonl`
- [ ] 记忆存储到 `workspace/{id}/data/memories.jsonl`
- [ ] `cloudmind.db` 不再包含 `agents`、`chat_messages`、`chat_sessions` 表
- [ ] 删除 Agent 时 `workspace/{id}/` 整个目录被删除
- [ ] 端到端测试通过

---

## 风险提醒

1. **破坏性变更**：实施后所有现有 Agent 数据丢失（已确认接受）
2. **性能**：JSON Lines 遍历在大数据量时可能慢，后续可引入 DuckDB 优化
3. **并发**：多请求同时写入同一 Agent 的同一文件需考虑锁机制（当前 FastAPI 单进程，可先简单实现）
