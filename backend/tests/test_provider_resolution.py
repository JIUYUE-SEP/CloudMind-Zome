"""Tests for provider_resolver.resolve_provider_credentials.

Replaces the old AgentWorker._resolve_provider() tests.
"""

from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, MagicMock

from app.services.provider_resolver import resolve_provider_credentials


class MockComputeProvider:
    def __init__(
        self,
        id: str,
        provider_type: str,
        base_url: str,
        api_key_encrypted: str,
        status: str = "active",
        auth_mode: str = "api_key",
        custom_headers: dict | None = None,
        request_timeout: float = 120.0,
        max_retries: int = 3,
        models: list | None = None,
    ):
        self.id = id
        self.provider_type = provider_type
        self.base_url = base_url
        self.config = {"base_url": base_url}
        self.api_key_encrypted = api_key_encrypted
        self.status = status
        self.auth_mode = auth_mode
        self.custom_headers = custom_headers or {}
        self.request_timeout = request_timeout
        self.max_retries = max_retries
        self.models = models or []


@pytest.fixture
def mock_db_session():
    session = AsyncMock()
    return session


@pytest.mark.asyncio
async def test_resolve_provider_by_id(mock_db_session):
    """Resolve by provider_id returns correct credentials."""
    from app.core.crypto import encrypt_value
    prov = MockComputeProvider(
        "p1", "deepseek", "https://api.ds.com",
        encrypt_value("sk-secret"),
    )
    mock_db_session.get = AsyncMock(return_value=prov)

    creds = await resolve_provider_credentials(mock_db_session, "p1", "deepseek-chat")

    assert creds is not None
    assert creds.provider_id == "p1"
    assert creds.provider_type == "deepseek"
    assert creds.base_url == "https://api.ds.com"
    assert creds.api_key == "sk-secret"
    assert creds.model_id == "deepseek-chat"
    assert creds.auth_mode == "api_key"


@pytest.mark.asyncio
async def test_resolve_provider_inactive_returns_none(mock_db_session):
    """Inactive provider returns None."""
    prov = MockComputeProvider(
        "p2", "deepseek", "https://api.ds.com", "", status="inactive",
    )
    mock_db_session.get = AsyncMock(return_value=prov)

    creds = await resolve_provider_credentials(mock_db_session, "p2")
    assert creds is None


@pytest.mark.asyncio
async def test_resolve_provider_not_found_returns_none(mock_db_session):
    """Missing provider returns None."""
    mock_db_session.get = AsyncMock(return_value=None)

    creds = await resolve_provider_credentials(mock_db_session, "missing")
    assert creds is None


@pytest.mark.asyncio
async def test_resolve_provider_empty_api_key_returns_empty_string(mock_db_session):
    """Provider with empty api_key_encrypted returns empty string (not None)."""
    from app.core.crypto import encrypt_value
    prov = MockComputeProvider(
        "p3", "deepseek", "https://x.com", encrypt_value(""),
    )
    mock_db_session.get = AsyncMock(return_value=prov)

    creds = await resolve_provider_credentials(mock_db_session, "p3")
    assert creds is not None
    assert creds.api_key is None


@pytest.mark.asyncio
async def test_resolve_provider_falls_back_to_first_active_model(mock_db_session):
    """When model_id is not provided, use first active model from provider."""
    from app.core.crypto import encrypt_value
    mock_model = MagicMock()
    mock_model.status = "active"
    mock_model.id = "deepseek-official::deepseek-chat"

    prov = MockComputeProvider(
        "p4", "deepseek", "https://api.ds.com",
        encrypt_value("sk-secret"),
        models=[mock_model],
    )
    mock_db_session.get = AsyncMock(return_value=prov)

    creds = await resolve_provider_credentials(mock_db_session, "p4")
    assert creds is not None
    assert creds.model_id == "deepseek-chat"
