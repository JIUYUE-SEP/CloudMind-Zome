"""Tests for AgentWorker fail-degradation of non-core capabilities."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from engine.agent.react import ReActAgent
from engine.context.embedder import Embedder
from engine.context.context_pipeline import ContextPipeline
from engine.message.types import Message, TextBlock
from engine.tools.web import image_gen_context
from engine.tools.web.generate_image import generate_image


class _FakeDBSession:
    def __init__(self, result):
        self._result = result

    async def execute(self, *args, **kwargs):
        return self._result

    async def commit(self):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False


def _make_async_session_local(row):
    result = MagicMock()
    result.scalar_one_or_none.return_value = row
    return lambda: _FakeDBSession(result)


class FakeCreds:
    provider_type = "openai"
    provider_id = "prov-1"
    api_key = "sk-fake"
    base_url = "http://fake"
    model_id = "fake-model"
    auth_mode = "api_key"
    custom_headers = None
    request_timeout = 30.0
    max_retries = 0


class _FakeTransport:
    def __init__(self, base_url="http://primary", model="primary"):
        self.base_url = base_url
        self.model = model


@pytest.fixture(autouse=True)
def _patch_app_state():
    from app import main
    main._app_state.setdefault("config", {})
    main._app_state.setdefault("session_store", MagicMock())
    main._app_state.setdefault("memory_store", MagicMock())
    yield
    main._app_state.clear()


@pytest.fixture
def mock_agent_row():
    from app.models import Agent
    row = MagicMock(spec=Agent)
    row.id = "agent-1"
    row.name = "TestAgent"
    row.codename = "TA"
    row.deleted_at = None
    row.model_config = {}
    row.provider_id = "prov-1"
    row.model_id = "model-1"
    row.marker_provider_id = None
    row.marker_model_id = None
    row.embedder_provider_id = "emb-1"
    row.embedder_model_id = "emb-model"
    row.imagegen_provider_id = "img-1"
    row.imagegen_model_id = "img-model"
    row.fallback_chain = []
    row.allowed_paths = []
    row.toolsets = []
    row.enabled_skills = []
    row.semantic_search_enabled = True
    row.image_generation_enabled = True
    row.topic_compression_enabled = True
    return row


@pytest.mark.asyncio
async def test_embedder_failure_disables_semantic_search(mock_agent_row):
    """If embedder build raises, semantic search is disabled but ReActAgent starts."""
    from app.services.agent_worker import AgentWorker

    worker = AgentWorker("agent-1")
    worker.agent_row = mock_agent_row

    async def fake_resolve(db, prov_id, model_id=None):
        return FakeCreds()

    async def fake_build_transport(*args, **kwargs):
        return _FakeTransport()

    with patch("app.services.agent_worker.AsyncSessionLocal", _make_async_session_local(mock_agent_row)), \
         patch("app.services.provider_resolver.resolve_provider_credentials", side_effect=fake_resolve), \
         patch("engine.provider.factory.build_transport", side_effect=fake_build_transport), \
         patch("engine.context.embedder.Embedder", side_effect=RuntimeError("embedder boom")):
        await worker.start()

    assert worker._running is True
    assert worker._react_agent is not None
    assert worker._react_agent.enable_semantic_search is False
    assert worker._react_agent.embedder is None


@pytest.mark.asyncio
async def test_imagegen_failure_disables_image_generation(mock_agent_row):
    """If imagegen config injection raises, image generation is disabled."""
    from app.services.agent_worker import AgentWorker

    worker = AgentWorker("agent-1")
    worker.agent_row = mock_agent_row

    async def fake_resolve(db, prov_id, model_id=None):
        return FakeCreds()

    async def fake_build_transport(*args, **kwargs):
        return _FakeTransport()

    with patch("app.services.agent_worker.AsyncSessionLocal", _make_async_session_local(mock_agent_row)), \
         patch("app.services.provider_resolver.resolve_provider_credentials", side_effect=fake_resolve), \
         patch("engine.provider.factory.build_transport", side_effect=fake_build_transport), \
         patch("engine.tools.web.image_gen_context.set_image_gen_config_for_agent", side_effect=RuntimeError("img boom")):
        await worker.start()

    assert worker._running is True
    assert worker._react_agent is not None
    assert worker._react_agent.enable_image_generation is False


@pytest.mark.asyncio
async def test_marker_failure_disables_topic_compression(mock_agent_row):
    """If marker config resolution raises, topic compression is disabled."""
    from app.services.agent_worker import AgentWorker

    mock_agent_row.marker_provider_id = "marker-1"
    worker = AgentWorker("agent-1")
    worker.agent_row = mock_agent_row

    async def fake_resolve(db, prov_id, model_id=None):
        if prov_id == "marker-1":
            raise RuntimeError("marker boom")
        return FakeCreds()

    async def fake_build_transport(*args, **kwargs):
        return _FakeTransport()

    with patch("app.services.agent_worker.AsyncSessionLocal", _make_async_session_local(mock_agent_row)), \
         patch("app.services.provider_resolver.resolve_provider_credentials", side_effect=fake_resolve), \
         patch("engine.provider.factory.build_transport", side_effect=fake_build_transport):
        await worker.start()

    assert worker._running is True
    assert worker._react_agent is not None
    assert worker._react_agent.enable_topic_compression is False


@pytest.mark.asyncio
async def test_semantic_search_disabled_skips_embedder():
    """ContextPipeline should not call embedder when semantic search is disabled."""
    embedder = MagicMock()
    embedder.embed_single = AsyncMock(return_value=[0.1, 0.2])

    memory_system = MagicMock()
    memory_system.get_topic_candidates = AsyncMock(return_value=[])
    memory_store = MagicMock()

    agent = ReActAgent(
        name="TestAgent",
        model=_FakeTransport(),
        toolkit=MagicMock(),
        agent_id="test-agent",
        embedder=embedder,
        memory_store=memory_store,
        memory_system=memory_system,
        enable_semantic_search=False,
    )

    # embedder should be cleared
    assert agent.embedder is None

    pipeline = ContextPipeline(
        agent_id="test-agent",
        msg_builder=MagicMock(),
        embedder=agent.embedder,
        memory_store=memory_store,
        memory_system=memory_system,
    )

    candidates = await pipeline._retrieve_semantic([Message(role="user", content="hello")])
    assert candidates == []
    embedder.embed_single.assert_not_awaited()


@pytest.mark.asyncio
async def test_image_generation_disabled_returns_error():
    """generate_image should return friendly error when image generation is disabled."""
    image_gen_context.set_image_gen_config_for_agent("agent-no-img", {
        "base_url": "",
        "model": "",
        "api_key": "",
    })
    from engine.tools.comms.context import set_current_agent_id
    set_current_agent_id("agent-no-img")

    result = await generate_image("a cat")
    assert "not available" in result

    image_gen_context.remove_image_gen_config_for_agent("agent-no-img")
    set_current_agent_id("")


@pytest.mark.asyncio
async def test_topic_compression_disabled_uses_simple_memory():
    """ReActAgent should use simple memory when topic compression is disabled."""
    agent = ReActAgent(
        name="TestAgent",
        model=_FakeTransport(),
        toolkit=MagicMock(),
        agent_id="test-agent",
        enable_topic_compression=False,
    )

    assert agent.enable_topic_compression is False
    assert agent.memory_system is not None
    assert agent.memory_system.__class__.__name__ == "SimpleMemory"
