"""WebSocket authentication tests.

Covers the token gate added to ``/api/v1/ws``:
- missing token is rejected
- invalid token is rejected
- valid signed token is accepted
- the well-known guest token is accepted
"""

from __future__ import annotations

import sys
from contextlib import asynccontextmanager
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
import pytest_asyncio

# Ensure backend/ is on path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import WebSocketDisconnect, status
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.api import ws as ws_module
from app.api import ws_handlers as handlers_module
from app.core.security import GUEST_TOKEN, GUEST_USER_ID, create_access_token
from app.database import Base
from app.models import User
from app.services.event_bus import manager


@pytest_asyncio.fixture
async def db_factory():
    """Create an in-memory DB with a guest and a regular user."""
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    Session = async_sessionmaker(
        engine, class_=AsyncSession, expire_on_commit=False, autoflush=False
    )

    async with Session() as session:
        guest = User(
            id=GUEST_USER_ID,
            codename="guest",
            nickname="访客",
            password_hash=None,
            device_id="guest-device",
            role="guest",
        )
        tester = User(
            id="11111111-1111-1111-1111-111111111111",
            codename="tester",
            nickname="Tester",
            password_hash=None,
            device_id="test-device",
            role="user",
        )
        session.add(guest)
        session.add(tester)
        await session.commit()

    yield Session
    await engine.dispose()


@pytest.fixture
def override_session(db_factory):
    """Return an async context manager that yields a fresh DB session."""

    @asynccontextmanager
    async def _session():
        async with db_factory() as session:
            yield session

    return _session


@pytest.fixture
def patched_ws(monkeypatch, override_session):
    """Patch session factories used by ws.py and ws_handlers.py."""
    monkeypatch.setattr(ws_module, "AsyncSessionLocal", override_session)
    monkeypatch.setattr(handlers_module, "AsyncSessionLocal", override_session)
    manager._connections.clear()
    yield
    manager._connections.clear()


def _make_ws_mock():
    """Build an AsyncMock WebSocket that disconnects immediately."""
    ws_mock = AsyncMock()
    ws_mock.receive_text = AsyncMock(side_effect=WebSocketDisconnect())
    return ws_mock


@pytest.mark.asyncio
async def test_ws_missing_token_is_rejected(patched_ws):
    ws_mock = _make_ws_mock()
    await ws_module.websocket_endpoint(ws_mock, token=None)
    ws_mock.close.assert_awaited_once_with(code=status.WS_1008_POLICY_VIOLATION)
    ws_mock.accept.assert_not_awaited()


@pytest.mark.asyncio
async def test_ws_invalid_token_is_rejected(patched_ws):
    ws_mock = _make_ws_mock()
    await ws_module.websocket_endpoint(ws_mock, token="not-a-valid-token")
    ws_mock.close.assert_awaited_once_with(code=status.WS_1008_POLICY_VIOLATION)
    ws_mock.accept.assert_not_awaited()


@pytest.mark.asyncio
async def test_ws_guest_token_is_accepted(patched_ws):
    ws_mock = _make_ws_mock()
    await ws_module.websocket_endpoint(ws_mock, token=GUEST_TOKEN)
    ws_mock.close.assert_not_awaited()
    # manager.connect accepts the socket; this only happens for valid tokens.
    ws_mock.accept.assert_awaited_once()


@pytest.mark.asyncio
async def test_ws_valid_signed_token_is_accepted(patched_ws):
    tester_id = "11111111-1111-1111-1111-111111111111"
    token = create_access_token(tester_id)
    ws_mock = _make_ws_mock()
    await ws_module.websocket_endpoint(ws_mock, token=token)
    ws_mock.close.assert_not_awaited()
    ws_mock.accept.assert_awaited_once()
