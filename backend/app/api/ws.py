"""WebSocket API: thin routing layer.

Business logic moved to ws_handlers.py.
Protocol helpers moved to ws_protocol.py.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, status
from sqlalchemy import update

from sqlalchemy.ext.asyncio import AsyncSession

from ..database import AsyncSessionLocal
from ..models import ChatSessionMember
from ..services.event_bus import manager
from .ws_handlers import _handle_agent_stop, _handle_chat_send, _handle_typing, _replay_offline_messages

logger = logging.getLogger(__name__)
router = APIRouter()


# Fixed user identifier for single-user local app
_USER_ID = "user"


def _handle_task_exception(task: asyncio.Task) -> None:
    """Log and swallow exceptions from fire-and-forget WS handler tasks."""
    try:
        task.result()
    except asyncio.CancelledError:
        pass
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("WS handler task failed")


# ------------------------------------------------------------------
# Main WebSocket endpoint
# ------------------------------------------------------------------
@router.websocket("/api/v1/ws")
async def websocket_endpoint(ws: WebSocket):
    await manager.connect(_USER_ID, ws)
    await ws.send_json({"type": "auth.success", "payload": {"user_id": _USER_ID}})

    # Replay offline messages
    await _replay_offline_messages(_USER_ID, ws)

    # Update last_seen
    async with AsyncSessionLocal() as db:
        await db.execute(
            update(ChatSessionMember)
            .where(ChatSessionMember.member_id == _USER_ID, ChatSessionMember.member_type == "user")
            .values(last_disconnect_at=None)
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
                await _handle_agent_stop(payload, ws)
                continue

            if msg_type == "chat.typing":
                await _handle_typing(payload, ws)
                continue

            if msg_type == "chat.send":
                task = asyncio.create_task(_handle_chat_send(payload, ws))
                task.add_done_callback(_handle_task_exception)
                continue

    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("WS error for user %s", _USER_ID)
    finally:
        # Record disconnect time for offline replay
        async with AsyncSessionLocal() as db:
            await db.execute(
                update(ChatSessionMember)
                .where(ChatSessionMember.member_id == _USER_ID, ChatSessionMember.member_type == "user")
                .values(last_disconnect_at=datetime.now(timezone.utc))
            )
            await db.commit()
        manager.disconnect(_USER_ID, ws)
