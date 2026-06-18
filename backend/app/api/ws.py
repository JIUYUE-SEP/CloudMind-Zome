"""WebSocket API: thin routing layer.

Business logic moved to ws_handlers.py.
Protocol helpers moved to ws_protocol.py.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect, status
from sqlalchemy import update

from sqlalchemy.ext.asyncio import AsyncSession

from ..core.security import GUEST_TOKEN, verify_access_token
from ..database import AsyncSessionLocal
from ..models import ChatSessionMember, User
from ..services.event_bus import manager
from .ws_handlers import _handle_agent_stop, _handle_chat_send, _handle_typing, _replay_offline_messages

logger = logging.getLogger(__name__)
router = APIRouter()


# ------------------------------------------------------------------
# Helpers (WS-specific, not protocol)
# ------------------------------------------------------------------
async def _get_user_from_token(token: str | None, db: AsyncSession) -> User | None:
    """Resolve a WebSocket token to a User.

    Returns ``None`` when the token is missing or invalid so the endpoint can
    reject the connection with a policy-violation close code.
    """
    if token is None:
        return None
    return await verify_access_token(token, db)


# ------------------------------------------------------------------
# Main WebSocket endpoint
# ------------------------------------------------------------------
@router.websocket("/api/v1/ws")
async def websocket_endpoint(ws: WebSocket, token: str | None = Query(None)):
    async with AsyncSessionLocal() as db:
        user = await _get_user_from_token(token, db)

    if user is None:
        await ws.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    await manager.connect(user.id, ws)
    await ws.send_json({"type": "auth.success", "payload": {"user_id": user.id}})

    # Replay offline messages
    await _replay_offline_messages(user.id, ws)

    # Update user last_seen
    async with AsyncSessionLocal() as db:
        await db.execute(
            update(User).where(User.id == user.id).values(last_seen_at=datetime.now(timezone.utc))
        )
        await db.commit()

    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            msg_type = msg.get("type", "")
            payload = msg.get("payload", {})

            if msg_type == "ping":
                await ws.send_json({"type": "pong"})
                continue

            if msg_type == "agent.stop":
                await _handle_agent_stop(user, payload, ws)
                continue

            if msg_type == "chat.typing":
                await _handle_typing(user, payload, ws)
                continue

            if msg_type == "chat.send":
                asyncio.create_task(_handle_chat_send(user, payload, ws))
                continue

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.exception("WS error for user %s", user.id)
    finally:
        # Record disconnect time for offline replay
        async with AsyncSessionLocal() as db:
            await db.execute(
                update(ChatSessionMember)
                .where(ChatSessionMember.member_id == user.id, ChatSessionMember.member_type == "user")
                .values(last_disconnect_at=datetime.now(timezone.utc))
            )
            await db.commit()
        manager.disconnect(user.id, ws)
