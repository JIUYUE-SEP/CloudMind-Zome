"""Tests for Provider resolution from ComputeProvider table."""

from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from app.services.agent_worker import AgentWorker


class MockComputeProvider:
    def __init__(self, id, provider_type, base_url, api_key_encrypted, status="active"):
        self.id = id
        self.provider_type = provider_type
        self.config = {"base_url": base_url}
        self.api_key_encrypted = api_key_encrypted
        self.status = status


@pytest.fixture
def mock_db_session():
    session = AsyncMock()
    return session


@pytest.mark.asyncio
async def test_resolve_provider_by_id(mock_db_session):
    worker = AgentWorker("agent-1")
    prov = MockComputeProvider("p1", "deepseek", "https://api.ds.com", "a2V5")

    result_mock = MagicMock()
    result_mock.scalars.return_value.first.return_value = prov
    mock_db_session.execute = AsyncMock(return_value=result_mock)

    with patch("app.services.agent_worker.AsyncSessionLocal", return_value=mock_db_session):
        # Need async context manager
        mock_db_session.__aenter__ = AsyncMock(return_value=mock_db_session)
        mock_db_session.__aexit__ = AsyncMock(return_value=False)
        creds = await worker._resolve_provider(provider_id="p1")

    assert creds is not None
    assert creds["base_url"] == "https://api.ds.com"
    assert creds["api_key"] == "key"


@pytest.mark.asyncio
async def test_resolve_provider_by_type(mock_db_session):
    worker = AgentWorker("agent-1")
    prov = MockComputeProvider("p2", "mimo", "https://api.mimo.com", "a2V5Mg==")

    result_mock = MagicMock()
    result_mock.scalars.return_value.first.return_value = prov
    mock_db_session.execute = AsyncMock(return_value=result_mock)

    with patch("app.services.agent_worker.AsyncSessionLocal", return_value=mock_db_session):
        mock_db_session.__aenter__ = AsyncMock(return_value=mock_db_session)
        mock_db_session.__aexit__ = AsyncMock(return_value=False)
        creds = await worker._resolve_provider(provider_type="mimo")

    assert creds is not None
    assert creds["base_url"] == "https://api.mimo.com"
    assert creds["api_key"] == "key2"


@pytest.mark.asyncio
async def test_resolve_provider_no_match_returns_none(mock_db_session):
    worker = AgentWorker("agent-1")

    result_mock = MagicMock()
    result_mock.scalars.return_value.first.return_value = None
    mock_db_session.execute = AsyncMock(return_value=result_mock)

    with patch("app.services.agent_worker.AsyncSessionLocal", return_value=mock_db_session):
        mock_db_session.__aenter__ = AsyncMock(return_value=mock_db_session)
        mock_db_session.__aexit__ = AsyncMock(return_value=False)
        creds = await worker._resolve_provider(provider_id="missing")

    assert creds is None


@pytest.mark.asyncio
async def test_resolve_provider_empty_api_key_returns_none(mock_db_session):
    worker = AgentWorker("agent-1")
    prov = MockComputeProvider("p3", "deepseek", "https://x.com", "")

    result_mock = MagicMock()
    result_mock.scalars.return_value.first.return_value = prov
    mock_db_session.execute = AsyncMock(return_value=result_mock)

    with patch("app.services.agent_worker.AsyncSessionLocal", return_value=mock_db_session):
        mock_db_session.__aenter__ = AsyncMock(return_value=mock_db_session)
        mock_db_session.__aexit__ = AsyncMock(return_value=False)
        creds = await worker._resolve_provider(provider_id="p3")

    assert creds is None
