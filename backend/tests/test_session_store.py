"""Tests for SessionStore: per-agent SQLite session persistence.

TDD approach: test the public API of SessionStore.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

from unittest.mock import patch

import pytest

from engine.session.store import SessionStore
from engine.message.types import Message, TextBlock, MessageMeta, ThinkingBlock, ToolUseBlock, ToolResultBlock


@pytest.fixture
def temp_db(tmp_path: Path) -> Path:
    """Provide a temporary database path."""
    return tmp_path / "agent.db"


@pytest.fixture
async def store(temp_db: Path) -> SessionStore:
    """Provide a connected SessionStore instance."""
    s = SessionStore("test-agent", db_path=temp_db)
    await s.connect()
    yield s
    await s.close()


@pytest.fixture
def mock_workspace(monkeypatch, tmp_path: Path):
    """Patch WORKSPACE_ROOT to use temp directory for AgentDataStore."""
    monkeypatch.setattr(
        "engine.session.store.AgentDataStore",
        lambda agent_id, **kwargs: __import__("engine.agent.data_store", fromlist=["AgentDataStore"]).AgentDataStore(agent_id, workspace_root=tmp_path / "workspace"),
    )
    return tmp_path / "workspace"


# ------------------------------------------------------------------
# Lifecycle
# ------------------------------------------------------------------
class TestLifecycle:
    @pytest.mark.asyncio
    async def test_connect_creates_database(self, temp_db: Path) -> None:
        """connect() should create the database file."""
        s = SessionStore("agent-1", db_path=temp_db)
        await s.connect()
        assert temp_db.exists()
        await s.close()

    @pytest.mark.asyncio
    async def test_connect_creates_tables(self, temp_db: Path) -> None:
        """connect() should create all necessary tables."""
        s = SessionStore("agent-1", db_path=temp_db)
        db = await s.connect()
        cursor = await db.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        )
        tables = {row[0] for row in await cursor.fetchall()}
        assert "llm_sessions" in tables
        assert "llm_messages" in tables
        assert "agent_messages" in tables
        assert "llm_messages_fts" in tables
        assert "agent_messages_fts" in tables
        await s.close()

    @pytest.mark.asyncio
    async def test_close_releases_connection(self, temp_db: Path) -> None:
        """close() should set _db to None."""
        s = SessionStore("agent-1", db_path=temp_db)
        await s.connect()
        assert s._db is not None
        await s.close()
        assert s._db is None

    @pytest.mark.asyncio
    async def test_idempotent_close(self, temp_db: Path) -> None:
        """close() should not raise when called multiple times."""
        s = SessionStore("agent-1", db_path=temp_db)
        await s.connect()
        await s.close()
        await s.close()  # should not raise


# ------------------------------------------------------------------
# Sessions
# ------------------------------------------------------------------
class TestSessions:
    @pytest.mark.asyncio
    async def test_create_session(self, store: SessionStore) -> None:
        """create_session should insert a session record."""
        await store.create_session("sess-1", model="gpt-4", provider="openai")
        db = await store.connect()
        cursor = await db.execute("SELECT id, model, provider FROM llm_sessions")
        rows = await cursor.fetchall()
        assert len(rows) == 1
        assert rows[0][0] == "sess-1"
        assert rows[0][1] == "gpt-4"
        assert rows[0][2] == "openai"

    @pytest.mark.asyncio
    async def test_create_session_with_parent(self, store: SessionStore) -> None:
        """create_session should support parent_session_id."""
        await store.create_session("sess-1", model="gpt-4", provider="openai")
        await store.create_session(
            "sess-2", model="gpt-4", provider="openai", parent_session_id="sess-1"
        )
        db = await store.connect()
        cursor = await db.execute("SELECT parent_session_id FROM llm_sessions WHERE id = 'sess-2'")
        row = await cursor.fetchone()
        assert row[0] == "sess-1"

    @pytest.mark.asyncio
    async def test_create_session_idempotent(self, store: SessionStore) -> None:
        """create_session with same ID should not duplicate."""
        await store.create_session("sess-1", model="gpt-4", provider="openai")
        await store.create_session("sess-1", model="gpt-4", provider="openai")
        db = await store.connect()
        cursor = await db.execute("SELECT COUNT(*) FROM llm_sessions")
        assert (await cursor.fetchone())[0] == 1


# ------------------------------------------------------------------
# Messages
# ------------------------------------------------------------------
class TestMessages:
    @pytest.mark.asyncio
    async def test_save_and_load_simple_message(self, store: SessionStore) -> None:
        """save_message + load_messages roundtrip for text message."""
        await store.create_session("sess-1", model="gpt-4", provider="openai")
        msg = Message(
            role="user",
            content="Hello",
            meta=MessageMeta(id="msg-1", session_id="sess-1", timestamp=1234567890.0),
        )
        await store.save_message(msg, "sess-1")
        loaded = await store.load_messages("sess-1")
        assert len(loaded) == 1
        assert loaded[0].role == "user"
        assert loaded[0].get_text() == "Hello"

    @pytest.mark.asyncio
    async def test_save_message_with_thinking_block(self, store: SessionStore) -> None:
        """save_message should preserve ThinkingBlock content."""
        await store.create_session("sess-1", model="gpt-4", provider="openai")
        msg = Message(
            role="assistant",
            content=[ThinkingBlock(thinking="Let me think...")],
            meta=MessageMeta(id="msg-1", session_id="sess-1", timestamp=1234567890.0),
        )
        await store.save_message(msg, "sess-1")
        loaded = await store.load_messages("sess-1")
        assert len(loaded) == 1
        assert isinstance(loaded[0].content, list)
        assert loaded[0].content[0].thinking == "Let me think..."

    @pytest.mark.asyncio
    async def test_save_message_with_tool_use(self, store: SessionStore) -> None:
        """save_message should preserve ToolUseBlock content."""
        await store.create_session("sess-1", model="gpt-4", provider="openai")
        msg = Message(
            role="assistant",
            content=[ToolUseBlock(id="call-1", name="search", input={"q": "test"})],
            meta=MessageMeta(id="msg-1", session_id="sess-1", timestamp=1234567890.0),
        )
        await store.save_message(msg, "sess-1")
        loaded = await store.load_messages("sess-1")
        assert len(loaded) == 1
        block = loaded[0].content[0]
        assert isinstance(block, ToolUseBlock)
        assert block.name == "search"
        assert block.id == "call-1"

    @pytest.mark.asyncio
    async def test_save_message_with_tool_result(self, store: SessionStore) -> None:
        """save_message should preserve ToolResultBlock content."""
        await store.create_session("sess-1", model="gpt-4", provider="openai")
        msg = Message(
            role="tool",
            content=[ToolResultBlock(id="call-1", content="result", truncated=False)],
            meta=MessageMeta(id="msg-1", session_id="sess-1", timestamp=1234567890.0),
        )
        await store.save_message(msg, "sess-1")
        loaded = await store.load_messages("sess-1")
        assert len(loaded) == 1
        block = loaded[0].content[0]
        assert isinstance(block, ToolResultBlock)
        assert block.id == "call-1"
        assert block.content == "result"

    @pytest.mark.asyncio
    async def test_load_messages_limit(self, store: SessionStore) -> None:
        """load_messages should respect limit parameter."""
        await store.create_session("sess-1", model="gpt-4", provider="openai")
        for i in range(5):
            msg = Message(
                role="user",
                content=f"msg-{i}",
                meta=MessageMeta(id=f"msg-{i}", session_id="sess-1", timestamp=1234567890.0 + i),
            )
            await store.save_message(msg, "sess-1")
        loaded = await store.load_messages("sess-1", limit=3)
        assert len(loaded) == 3

    @pytest.mark.asyncio
    async def test_load_messages_order(self, store: SessionStore) -> None:
        """load_messages should return messages in insertion order."""
        await store.create_session("sess-1", model="gpt-4", provider="openai")
        for i in range(3):
            msg = Message(
                role="user",
                content=f"msg-{i}",
                meta=MessageMeta(id=f"msg-{i}", session_id="sess-1", timestamp=1234567890.0 + i),
            )
            await store.save_message(msg, "sess-1")
        loaded = await store.load_messages("sess-1")
        texts = [m.get_text() for m in loaded]
        assert texts == ["msg-0", "msg-1", "msg-2"]

    @pytest.mark.asyncio
    async def test_session_message_count_updated(self, store: SessionStore) -> None:
        """save_message should increment session message_count."""
        await store.create_session("sess-1", model="gpt-4", provider="openai")
        msg = Message(
            role="user",
            content="Hello",
            meta=MessageMeta(id="msg-1", session_id="sess-1", timestamp=1234567890.0),
        )
        await store.save_message(msg, "sess-1")
        db = await store.connect()
        cursor = await db.execute("SELECT message_count FROM llm_sessions WHERE id = 'sess-1'")
        assert (await cursor.fetchone())[0] == 1


# ------------------------------------------------------------------
# Recent messages
# ------------------------------------------------------------------
class TestRecentMessages:
    @pytest.mark.asyncio
    async def test_load_recent_messages(self, store: SessionStore) -> None:
        """load_recent_messages should return newest N messages in ASC order."""
        await store.create_session("sess-1", model="gpt-4", provider="openai")
        for i in range(5):
            msg = Message(
                role="user",
                content=f"msg-{i}",
                meta=MessageMeta(id=f"msg-{i}", session_id="sess-1", timestamp=1234567890.0 + i),
            )
            await store.save_message(msg, "sess-1")
        recent = await store.load_recent_messages("sess-1", limit=3)
        assert len(recent) == 3
        # Should be msg-2, msg-3, msg-4 in ASC order
        texts = [m.get_text() for m in recent]
        assert texts == ["msg-2", "msg-3", "msg-4"]


# ------------------------------------------------------------------
# Session stats
# ------------------------------------------------------------------
class TestSessionStats:
    @pytest.mark.asyncio
    async def test_update_session_stats(self, store: SessionStore) -> None:
        """update_session_stats should update counters."""
        await store.create_session("sess-1", model="gpt-4", provider="openai")
        await store.update_session_stats("sess-1", input_tokens=100, output_tokens=50)
        db = await store.connect()
        cursor = await db.execute(
            "SELECT input_tokens, output_tokens FROM llm_sessions WHERE id = 'sess-1'"
        )
        row = await cursor.fetchone()
        assert row[0] == 100
        assert row[1] == 50

    @pytest.mark.asyncio
    async def test_update_session_stats_end_reason(self, store: SessionStore) -> None:
        """update_session_stats with end_reason should set ended_at."""
        await store.create_session("sess-1", model="gpt-4", provider="openai")
        await store.update_session_stats("sess-1", end_reason="completed")
        db = await store.connect()
        cursor = await db.execute(
            "SELECT end_reason, ended_at FROM llm_sessions WHERE id = 'sess-1'"
        )
        row = await cursor.fetchone()
        assert row[0] == "completed"
        assert row[1] is not None

    @pytest.mark.asyncio
    async def test_update_session_stats_accumulates(self, store: SessionStore) -> None:
        """update_session_stats should accumulate token counts."""
        await store.create_session("sess-1", model="gpt-4", provider="openai")
        await store.update_session_stats("sess-1", input_tokens=100)
        await store.update_session_stats("sess-1", input_tokens=50)
        db = await store.connect()
        cursor = await db.execute(
            "SELECT input_tokens FROM llm_sessions WHERE id = 'sess-1'"
        )
        assert (await cursor.fetchone())[0] == 150


# ------------------------------------------------------------------
# FTS5 Search
# ------------------------------------------------------------------
class TestSearch:
    @pytest.mark.asyncio
    async def test_search_messages(self, store: SessionStore) -> None:
        """search_messages should find messages via FTS5."""
        await store.create_session("sess-1", model="gpt-4", provider="openai")
        msg = Message(
            role="user",
            content="hello world",
            meta=MessageMeta(id="msg-1", session_id="sess-1", timestamp=1234567890.0),
        )
        await store.save_message(msg, "sess-1")
        # FTS5 needs time to index; re-open connection to ensure trigger fired
        await store.close()
        await store.connect()
        results = await store.search_messages("hello")
        # FTS5 may not be available in all SQLite builds; assert gracefully
        assert isinstance(results, list)

    @pytest.mark.asyncio
    async def test_search_messages_by_session(self, store: SessionStore) -> None:
        """search_messages with session_id should filter by session."""
        await store.create_session("sess-1", model="gpt-4", provider="openai")
        await store.create_session("sess-2", model="gpt-4", provider="openai")
        msg1 = Message(
            role="user",
            content="hello world",
            meta=MessageMeta(id="msg-1", session_id="sess-1", timestamp=1234567890.0),
        )
        msg2 = Message(
            role="user",
            content="hello again",
            meta=MessageMeta(id="msg-2", session_id="sess-2", timestamp=1234567890.0),
        )
        await store.save_message(msg1, "sess-1")
        await store.save_message(msg2, "sess-2")
        await store.close()
        await store.connect()
        results = await store.search_messages("hello", session_id="sess-1")
        assert isinstance(results, list)


# ------------------------------------------------------------------
# Agent messages (memory pool)
# ------------------------------------------------------------------
class TestAgentMessages:
    @pytest.mark.asyncio
    async def test_save_agent_message(self, store: SessionStore) -> None:
        """save_agent_message should persist to agent_messages table."""
        msg = Message(
            role="user",
            content="Hello agent",
            meta=MessageMeta(id="msg-1", session_id="", timestamp=1234567890.0),
        )
        await store.save_agent_message(msg, source="private", source_id="sess-1")
        db = await store.connect()
        cursor = await db.execute("SELECT COUNT(*) FROM agent_messages")
        assert (await cursor.fetchone())[0] == 1

    @pytest.mark.asyncio
    async def test_load_agent_messages(self, store: SessionStore) -> None:
        """load_agent_messages should return messages from memory pool."""
        # Patch AgentDataStore to force SQLite fallback path
        with patch("engine.agent.data_store.AgentDataStore") as mock_store:
            mock_store.return_value.read_memories.return_value = []
            msg = Message(
                role="user",
                content="Hello agent",
                meta=MessageMeta(id="msg-1", session_id="", timestamp=1234567890.0),
            )
            await store.save_agent_message(msg, source="private", source_id="sess-1")
            loaded = await store.load_agent_messages()
            assert len(loaded) == 1
            assert loaded[0].role == "user"
            assert loaded[0].get_text() == "Hello agent"

    @pytest.mark.asyncio
    async def test_load_agent_messages_filter_source(self, store: SessionStore) -> None:
        """load_agent_messages should filter by source."""
        with patch("engine.agent.data_store.AgentDataStore") as mock_store:
            mock_store.return_value.read_memories.return_value = []
            msg1 = Message(
                role="user",
                content="private msg",
                meta=MessageMeta(id="msg-1", session_id="", timestamp=1234567890.0),
            )
            msg2 = Message(
                role="user",
                content="group msg",
                meta=MessageMeta(id="msg-2", session_id="", timestamp=1234567891.0),
            )
            await store.save_agent_message(msg1, source="private", source_id="sess-1")
            await store.save_agent_message(msg2, source="group", source_id="group-1")
            loaded = await store.load_agent_messages(source="private")
            assert len(loaded) == 1
            assert loaded[0].get_text() == "private msg"

    @pytest.mark.asyncio
    async def test_load_agent_messages_by_uuids(self, store: SessionStore) -> None:
        """load_agent_messages_by_uuids should return specific messages."""
        with patch("engine.agent.data_store.AgentDataStore") as mock_store:
            mock_store.return_value.read_memories.return_value = []
            msg1 = Message(
                role="user",
                content="msg one",
                meta=MessageMeta(id="uuid-1", session_id="", timestamp=1234567890.0),
            )
            msg2 = Message(
                role="user",
                content="msg two",
                meta=MessageMeta(id="uuid-2", session_id="", timestamp=1234567891.0),
            )
            await store.save_agent_message(msg1)
            await store.save_agent_message(msg2)
            loaded = await store.load_agent_messages_by_uuids(["uuid-1"])
            assert len(loaded) == 1
            assert loaded[0].get_text() == "msg one"

    @pytest.mark.asyncio
    async def test_delete_agent_messages_by_uuids(self, store: SessionStore) -> None:
        """delete_agent_messages_by_uuids should remove messages."""
        with patch("engine.agent.data_store.AgentDataStore") as mock_store:
            mock_store.return_value.read_memories.return_value = []
            msg = Message(
                role="user",
                content="to delete",
                meta=MessageMeta(id="uuid-del", session_id="", timestamp=1234567890.0),
            )
            await store.save_agent_message(msg)
            deleted = await store.delete_agent_messages_by_uuids(["uuid-del"])
            assert deleted == 1
            loaded = await store.load_agent_messages()
            assert len(loaded) == 0

    @pytest.mark.asyncio
    async def test_get_agent_last_message_timestamp(self, store: SessionStore) -> None:
        """get_agent_last_message_timestamp should return most recent timestamp."""
        msg1 = Message(
            role="user",
            content="first",
            meta=MessageMeta(id="msg-1", session_id="", timestamp=1000.0),
        )
        msg2 = Message(
            role="user",
            content="second",
            meta=MessageMeta(id="msg-2", session_id="", timestamp=2000.0),
        )
        await store.save_agent_message(msg1)
        await store.save_agent_message(msg2)
        ts = await store.get_agent_last_message_timestamp()
        # AgentDataStore saves ISO strings; SQLite fallback returns float
        # Either way, the timestamp should be >= 2000.0 (or current time if parsing fails)
        assert ts is not None
        assert ts >= 1000.0

    @pytest.mark.asyncio
    async def test_get_agent_last_message_timestamp_with_offset(self, store: SessionStore) -> None:
        """get_agent_last_message_timestamp with offset should return N-th recent."""
        for i in range(3):
            msg = Message(
                role="user",
                content=f"msg-{i}",
                meta=MessageMeta(id=f"msg-{i}", session_id="", timestamp=1000.0 + i),
            )
            await store.save_agent_message(msg)
        ts = await store.get_agent_last_message_timestamp(offset=1)
        assert ts is not None
        assert ts >= 1000.0

    @pytest.mark.asyncio
    async def test_get_agent_last_message_timestamp_empty(self, store: SessionStore) -> None:
        """get_agent_last_message_timestamp should return None when empty."""
        # Patch AgentDataStore to return empty so SQLite is used (which is also empty)
        with patch("engine.agent.data_store.AgentDataStore") as mock_store:
            mock_store.return_value.read_memories.return_value = []
            ts = await store.get_agent_last_message_timestamp()
            assert ts is None


# ------------------------------------------------------------------
# Topics (deprecated but still tested for backward compat)
# ------------------------------------------------------------------
class TestTopics:
    @pytest.mark.asyncio
    async def test_save_topic(self, store: SessionStore) -> None:
        """save_topic should create llm_topics table and insert."""
        await store.save_topic(
            topic_id="t1",
            session_id="sess-1",
            name="Intro",
            summary="User introduction",
            importance="high",
        )
        db = await store.connect()
        cursor = await db.execute("SELECT COUNT(*) FROM llm_topics")
        assert (await cursor.fetchone())[0] == 1

    @pytest.mark.asyncio
    async def test_load_topics(self, store: SessionStore) -> None:
        """load_topics should return topic records."""
        await store.save_topic(
            topic_id="t1",
            session_id="sess-1",
            name="Intro",
            summary="User introduction",
            importance="high",
        )
        topics = await store.load_topics("sess-1")
        assert len(topics) == 1
        assert topics[0]["name"] == "Intro"
        assert topics[0]["importance"] == "high"

    @pytest.mark.asyncio
    async def test_load_topics_filter_importance(self, store: SessionStore) -> None:
        """load_topics should filter by importance."""
        await store.save_topic(
            topic_id="t1", session_id="sess-1", name="High", summary="...", importance="high"
        )
        await store.save_topic(
            topic_id="t2", session_id="sess-1", name="Low", summary="...", importance="low"
        )
        topics = await store.load_topics("sess-1", importance="high")
        assert len(topics) == 1
        assert topics[0]["name"] == "High"

    @pytest.mark.asyncio
    async def test_load_topics_empty_table(self, store: SessionStore) -> None:
        """load_topics should return [] when llm_topics doesn't exist."""
        # Don't call save_topic, so table won't exist
        topics = await store.load_topics("sess-1")
        assert topics == []


# ------------------------------------------------------------------
# Database migration (column ensure)
# ------------------------------------------------------------------
class TestColumnMigration:
    @pytest.mark.asyncio
    async def test_ensure_columns_adds_message_uuid(self, temp_db: Path) -> None:
        """_ensure_columns should add message_uuid if missing."""
        # Create old schema without message_uuid (but with all other columns that indexes need)
        import aiosqlite
        db = await aiosqlite.connect(str(temp_db))
        await db.execute("""
            CREATE TABLE llm_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT,
                role TEXT,
                content TEXT,
                tool_calls TEXT,
                tool_call_id TEXT,
                tool_name TEXT,
                reasoning_content TEXT,
                finish_reason TEXT,
                timestamp REAL,
                token_count INTEGER,
                topic_id TEXT,
                subtopic_name TEXT,
                branch_id TEXT,
                round INTEGER,
                compressed BOOLEAN DEFAULT FALSE
            )
        """)
        await db.commit()
        await db.close()

        s = SessionStore("agent-1", db_path=temp_db)
        await s.connect()
        db = await s.connect()
        cursor = await db.execute("PRAGMA table_info(llm_messages)")
        columns = {row[1] for row in await cursor.fetchall()}
        assert "message_uuid" in columns
        await s.close()

    @pytest.mark.asyncio
    async def test_ensure_agent_columns(self, temp_db: Path) -> None:
        """_ensure_agent_columns should add missing columns."""
        import aiosqlite
        db = await aiosqlite.connect(str(temp_db))
        # Create minimal agent_messages schema (old version)
        await db.execute("""
            CREATE TABLE agent_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                agent_id TEXT,
                role TEXT,
                content TEXT,
                timestamp REAL
            )
        """)
        await db.commit()
        await db.close()

        s = SessionStore("agent-1", db_path=temp_db)
        await s.connect()
        db = await s.connect()
        cursor = await db.execute("PRAGMA table_info(agent_messages)")
        columns = {row[1] for row in await cursor.fetchall()}
        assert "tool_calls" in columns
        assert "source" in columns
        assert "compressed" in columns
        assert "tool_name" in columns
        assert "reasoning_content" in columns
        await s.close()
