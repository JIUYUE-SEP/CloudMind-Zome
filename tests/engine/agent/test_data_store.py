import json
import shutil
import sys
import tempfile
from pathlib import Path

import pytest

# Add backend to path for imports
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent.parent / "backend"))

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

        messages = store.read_messages("sess_001")
        assert len(messages) == 2
        assert messages[0]["content"] == "Hello"
        assert messages[1]["content"] == "World"

    def test_sessions(self, temp_workspace):
        store = AgentDataStore("agent_001", workspace_root=temp_workspace)
        store.append_session({"id": "sess_001", "type": "private"})
        store.append_session({"id": "sess_002", "type": "group"})

        sessions = store.read_sessions()
        assert len(sessions) == 2

        private_sessions = store.filter_sessions(lambda s: s["type"] == "private")
        assert len(private_sessions) == 1
        assert private_sessions[0]["id"] == "sess_001"

    def test_memories(self, temp_workspace):
        store = AgentDataStore("agent_001", workspace_root=temp_workspace)
        store.append_memory({"id": "mem_1", "content": "User likes tea"})
        store.append_memory({"id": "mem_2", "content": "User hates coffee"})

        memories = store.read_memories()
        assert len(memories) == 2

    def test_llm_sessions(self, temp_workspace):
        store = AgentDataStore("agent_001", workspace_root=temp_workspace)
        store.append_llm_session({"id": "llm_1", "model": "gpt-4"})
        store.append_llm_session({"id": "llm_2", "model": "gpt-3.5"})

        sessions = store.read_llm_sessions()
        assert len(sessions) == 2

        gpt4_sessions = store.filter_llm_sessions(lambda s: s["model"] == "gpt-4")
        assert len(gpt4_sessions) == 1

    def test_llm_messages(self, temp_workspace):
        store = AgentDataStore("agent_001", workspace_root=temp_workspace)
        store.append_llm_message({"id": "msg_1", "session_id": "sess_001", "content": "Hello"})
        store.append_llm_message({"id": "msg_2", "session_id": "sess_001", "content": "World"})

        messages = store.read_llm_messages()
        assert len(messages) == 2

    def test_delete_all(self, temp_workspace):
        store = AgentDataStore("agent_001", workspace_root=temp_workspace)
        store.write_config({"name": "Test"})
        store.append_message("sess_001", {"id": "msg_1", "content": "Hello"})
        store.delete_all()
        assert not store.agent_dir.exists()

    def test_missing_file_returns_empty(self, temp_workspace):
        store = AgentDataStore("agent_001", workspace_root=temp_workspace)
        assert store.read_config() is None
        assert store.read_sessions() == []
        assert store.read_messages("nonexistent") == []
        assert store.read_memories() == []
        assert store.read_llm_sessions() == []
        assert store.read_llm_messages() == []

    def test_jsonl_format(self, temp_workspace):
        store = AgentDataStore("agent_001", workspace_root=temp_workspace)
        store.append_message("sess_001", {"id": "msg_1", "content": "Hello"})
        store.append_message("sess_001", {"id": "msg_2", "content": "World"})

        # Verify raw file format
        message_file = store._message_path("sess_001")
        with message_file.open("r", encoding="utf-8") as f:
            lines = f.readlines()
        assert len(lines) == 2
        for line in lines:
            record = json.loads(line)
            assert "id" in record
            assert "content" in record
