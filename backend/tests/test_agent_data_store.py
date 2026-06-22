"""Tests for AgentDataStore document-based storage.

TDD approach: test the public API of AgentDataStore.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from engine.agent.data_store import AgentDataStore


@pytest.fixture
def temp_workspace(tmp_path: Path) -> Path:
    """Provide a temporary workspace root."""
    ws = tmp_path / "workspace"
    ws.mkdir()
    return ws


@pytest.fixture
def store(temp_workspace: Path) -> AgentDataStore:
    """Provide an AgentDataStore instance backed by temp workspace."""
    return AgentDataStore("test-agent", workspace_root=temp_workspace)


# ------------------------------------------------------------------
# Config
# ------------------------------------------------------------------
class TestConfig:
    def test_read_config_missing_returns_none(self, store: AgentDataStore) -> None:
        """Reading config for non-existent agent returns None."""
        assert store.read_config() is None

    def test_write_and_read_config(self, store: AgentDataStore) -> None:
        """Config written should be readable back."""
        data = {"name": "Test Agent", "provider_id": "openai"}
        store.write_config(data)
        result = store.read_config()
        assert result == data

    def test_update_config_merges(self, store: AgentDataStore) -> None:
        """update_config merges into existing config."""
        store.write_config({"name": "Old", "provider_id": "x"})
        result = store.update_config({"name": "New"})
        assert result["name"] == "New"
        assert result["provider_id"] == "x"

    def test_update_config_creates_new(self, store: AgentDataStore) -> None:
        """update_config creates config if none exists."""
        result = store.update_config({"name": "Created"})
        assert result["name"] == "Created"

    def test_config_is_human_readable_json(self, store: AgentDataStore) -> None:
        """Config file should be human-readable JSON with indentation."""
        store.write_config({"name": "Agent"})
        text = (store.agent_dir / "config.json").read_text(encoding="utf-8")
        assert "\n" in text  # has indentation
        assert json.loads(text) == {"name": "Agent"}


# ------------------------------------------------------------------
# Sessions (JSON Lines)
# ------------------------------------------------------------------
class TestSessions:
    def test_read_sessions_empty(self, store: AgentDataStore) -> None:
        """Reading sessions with no file returns empty list."""
        assert store.read_sessions() == []

    def test_append_and_read_sessions(self, store: AgentDataStore) -> None:
        """Appended sessions should be readable."""
        store.append_session({"id": "s1", "title": "First"})
        store.append_session({"id": "s2", "title": "Second"})
        sessions = store.read_sessions()
        assert len(sessions) == 2
        assert sessions[0]["id"] == "s1"
        assert sessions[1]["title"] == "Second"

    def test_write_sessions_overwrites(self, store: AgentDataStore) -> None:
        """write_sessions should replace all existing sessions."""
        store.append_session({"id": "old"})
        store.write_sessions([{"id": "new"}])
        sessions = store.read_sessions()
        assert len(sessions) == 1
        assert sessions[0]["id"] == "new"

    def test_filter_sessions(self, store: AgentDataStore) -> None:
        """filter_sessions should return matching records."""
        store.append_session({"id": "s1", "active": True})
        store.append_session({"id": "s2", "active": False})
        active = store.filter_sessions(lambda s: s.get("active"))
        assert len(active) == 1
        assert active[0]["id"] == "s1"


# ------------------------------------------------------------------
# Messages per session
# ------------------------------------------------------------------
class TestMessages:
    def test_read_messages_empty(self, store: AgentDataStore) -> None:
        """Reading messages for non-existent session returns empty list."""
        assert store.read_messages("no-session") == []

    def test_append_and_read_messages(self, store: AgentDataStore) -> None:
        """Messages appended to a session should be readable."""
        store.append_message("sess-1", {"role": "user", "content": "hi"})
        store.append_message("sess-1", {"role": "assistant", "content": "hello"})
        msgs = store.read_messages("sess-1")
        assert len(msgs) == 2
        assert msgs[0]["role"] == "user"
        assert msgs[1]["content"] == "hello"

    def test_messages_isolated_per_session(self, store: AgentDataStore) -> None:
        """Messages for different sessions should not mix."""
        store.append_message("sess-a", {"content": "a"})
        store.append_message("sess-b", {"content": "b"})
        assert len(store.read_messages("sess-a")) == 1
        assert store.read_messages("sess-a")[0]["content"] == "a"
        assert store.read_messages("sess-b")[0]["content"] == "b"

    def test_write_messages_overwrites(self, store: AgentDataStore) -> None:
        """write_messages replaces all messages for a session."""
        store.append_message("sess-1", {"content": "old"})
        store.write_messages("sess-1", [{"content": "new"}])
        msgs = store.read_messages("sess-1")
        assert len(msgs) == 1
        assert msgs[0]["content"] == "new"

    def test_filter_messages(self, store: AgentDataStore) -> None:
        """filter_messages returns matching messages."""
        store.append_message("sess-1", {"role": "user", "content": "hi"})
        store.append_message("sess-1", {"role": "assistant", "content": "hello"})
        user_msgs = store.filter_messages("sess-1", lambda m: m["role"] == "user")
        assert len(user_msgs) == 1
        assert user_msgs[0]["content"] == "hi"


# ------------------------------------------------------------------
# LLM sessions / messages
# ------------------------------------------------------------------
class TestLlmData:
    def test_llm_sessions_roundtrip(self, store: AgentDataStore) -> None:
        """LLM sessions should be appendable and readable."""
        store.append_llm_session({"id": "ls1", "model": "gpt-4"})
        sessions = store.read_llm_sessions()
        assert len(sessions) == 1
        assert sessions[0]["model"] == "gpt-4"

    def test_llm_messages_roundtrip(self, store: AgentDataStore) -> None:
        """LLM messages should be appendable and readable."""
        store.append_llm_message({"role": "system", "content": "sys"})
        msgs = store.read_llm_messages()
        assert len(msgs) == 1
        assert msgs[0]["content"] == "sys"

    def test_llm_write_overwrites(self, store: AgentDataStore) -> None:
        """write_llm_sessions overwrites existing data."""
        store.append_llm_session({"id": "old"})
        store.write_llm_sessions([{"id": "new"}])
        assert len(store.read_llm_sessions()) == 1
        assert store.read_llm_sessions()[0]["id"] == "new"


# ------------------------------------------------------------------
# Memories
# ------------------------------------------------------------------
class TestMemories:
    def test_memories_roundtrip(self, store: AgentDataStore) -> None:
        """Memories should be appendable and readable."""
        store.append_memory({"scene": "intro", "fact": "user likes tea"})
        memories = store.read_memories()
        assert len(memories) == 1
        assert memories[0]["fact"] == "user likes tea"

    def test_filter_memories(self, store: AgentDataStore) -> None:
        """filter_memories returns matching records."""
        store.append_memory({"scene": "intro", "fact": "tea"})
        store.append_memory({"scene": "battle", "fact": "sword"})
        intro = store.filter_memories(lambda m: m["scene"] == "intro")
        assert len(intro) == 1
        assert intro[0]["fact"] == "tea"


# ------------------------------------------------------------------
# Delete
# ------------------------------------------------------------------
class TestDelete:
    def test_delete_all_removes_directory(self, store: AgentDataStore) -> None:
        """delete_all should remove the entire agent directory."""
        store.write_config({"name": "ToDelete"})
        assert store.agent_dir.exists()
        store.delete_all()
        assert not store.agent_dir.exists()

    def test_delete_all_idempotent(self, store: AgentDataStore) -> None:
        """delete_all should not raise if directory does not exist."""
        assert not store.agent_dir.exists()
        store.delete_all()  # should not raise


# ------------------------------------------------------------------
# Directory structure
# ------------------------------------------------------------------
class TestDirectoryStructure:
    def test_ensure_dirs_creates_structure(self, store: AgentDataStore) -> None:
        """ensure_dirs should create all necessary directories."""
        store.ensure_dirs()
        assert store.agent_dir.exists()
        assert (store.agent_dir / "data").exists()
        assert (store.agent_dir / "data" / "messages").exists()

    def test_agent_dir_path(self, temp_workspace: Path) -> None:
        """Agent directory should be under workspace/{agent_id}."""
        store = AgentDataStore("my-agent", workspace_root=temp_workspace)
        assert store.agent_dir == temp_workspace / "my-agent"
