import os

import pytest
from engine.message.types import Message, TextBlock
from engine.session.store import SessionStore


@pytest.fixture
async def store(tmp_path, monkeypatch):
    data_dir = tmp_path / "data"
    monkeypatch.setenv("CLOUDMIND_DATA_DIR", str(data_dir))
    workspace = data_dir / "workspace"
    s = SessionStore("agent-a", db_path=workspace / "agent-a" / "agent.db")
    yield s
    await s.close()


@pytest.mark.asyncio
async def test_delete_by_uuid_also_removes_from_jsonl(store, tmp_path):
    msg = Message(role="user", content=[TextBlock(text="hello")])
    await store.save_agent_message(msg, source="private", source_id="")

    # Determine the generated uuid
    from engine.agent.data_store import AgentDataStore
    ds = AgentDataStore("agent-a", workspace_root=tmp_path / "data" / "workspace")
    memories = ds.read_memories()
    assert len(memories) == 1
    uuid = memories[0]["message_uuid"]

    deleted = await store.delete_agent_messages_by_uuids([uuid])
    assert deleted == 1

    memories_after = ds.read_memories()
    assert len(memories_after) == 0
