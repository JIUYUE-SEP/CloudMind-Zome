"""WebSocket API: real-time chat, notifications, action progress.

Protocol: single WebSocket connection per client.
Auth via query param ?token=xxx or first auth frame.
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict

from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from ..database import AsyncSessionLocal
from ..dependencies import require_user
from ..models import Agent, ChatMessage, ChatSession, ChatSessionMember, User
from ..services.engine_bridge import EngineBridge
from ..services.group_chat_router import GroupChatRouter
from ..services.conductor_service import ConductorService
from ..services.event_bus import manager

logger = logging.getLogger(__name__)
router = APIRouter()

# ------------------------------------------------------------------
# Global stop signals for private chat interrupts
# Key: "{session_id}:{agent_id}" -> timestamp
# Only applies to private chat streams. TTL = 5 minutes.
# ------------------------------------------------------------------
_private_stop_signals: dict[str, float] = {}


def _set_stop_signal(signal_key: str) -> None:
    _private_stop_signals[signal_key] = datetime.now(timezone.utc).timestamp()
    # Prune stale entries (TTL 5 min)
    now = datetime.now(timezone.utc).timestamp()
    stale = [k for k, ts in _private_stop_signals.items() if now - ts > 300]
    for k in stale:
        _private_stop_signals.pop(k, None)


def _check_stop_signal(signal_key: str) -> bool:
    ts = _private_stop_signals.get(signal_key)
    if ts is None:
        return False
    now = datetime.now(timezone.utc).timestamp()
    if now - ts > 300:
        _private_stop_signals.pop(signal_key, None)
        return False
    return True


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------
async def _get_user_from_token(token: str | None, db: AsyncSession) -> User:
    """Return guest user (login-free mode)."""
    result = await db.execute(select(User).where(User.codename == "guest"))
    guest = result.scalar_one_or_none()
    if guest:
        return guest
    guest = User(
        id="00000000-0000-0000-0000-000000000000",
        codename="guest",
        nickname="访客",
        password_hash=None,
        device_id="guest-device",
        role="guest",
    )
    db.add(guest)
    await db.commit()
    await db.refresh(guest)
    return guest


def _build_ws_frame(msg_type: str, payload: dict) -> dict:
    return {
        "type": msg_type,
        "id": f"evt_{uuid.uuid4().hex[:12]}",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "payload": payload,
    }


def _engine_state() -> dict:
    from ..main import _app_state
    return _app_state


# ------------------------------------------------------------------
# Main WebSocket endpoint
# ------------------------------------------------------------------
@router.websocket("/api/v1/ws")
async def websocket_endpoint(
    ws: WebSocket,
    token: str | None = Query(None),
):
    async with AsyncSessionLocal() as db:
        user = await _get_user_from_token(token, db)

    # Guest users are always accepted thanks to _get_user_from_token fallback

    await manager.connect(user.id, ws)
    await ws.send_json({"type": "auth.success", "payload": {"user_id": user.id}})

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

            if msg_type == "chat.send":
                await _handle_chat_send(user, payload, ws)
                continue

    except WebSocketDisconnect:
        manager.disconnect(user.id, ws)
    except Exception as exc:
        logger.exception("WS error for user %s", user.id)
        manager.disconnect(user.id, ws)


# ------------------------------------------------------------------
# chat.send handler
# ------------------------------------------------------------------
async def _handle_chat_send(user: User, payload: dict, ws: WebSocket):
    session_id = payload.get("session_id", "")
    content = payload.get("content", "")

    async with AsyncSessionLocal() as db:
        # Verify membership
        mem = await db.execute(
            select(ChatSessionMember).where(
                ChatSessionMember.session_id == session_id,
                ChatSessionMember.member_id == user.id,
            )
        )
        if not mem.scalar_one_or_none():
            await ws.send_json(_build_ws_frame("error", {"message": "Not a member"}))
            return

        # Load session with members pre-loaded (selectin)
        sess_result = await db.execute(
            select(ChatSession).where(ChatSession.id == session_id)
            .options(selectinload(ChatSession.members))
        )
        session = sess_result.scalar_one_or_none()
        if not session:
            await ws.send_json(_build_ws_frame("error", {"message": "Session not found"}))
            return

        # Snapshot scalar data before any lazy loads
        session_type = session.type
        conductor_id = session.conductor_agent_id
        settings = session.settings or {}

        # Snapshot members into plain objects while session is active
        member_rows = list(session.members)
        other_members = [m for m in member_rows if m.member_id != user.id]

        # Save user message
        user_msg = ChatMessage(
            id=str(uuid.uuid4()),
            session_id=session_id,
            sender_id=user.id,
            sender_type="user",
            content=content,
            content_type=payload.get("content_type", "text"),
        )
        db.add(user_msg)
        session.last_message_at = datetime.now(timezone.utc)
        await db.commit()

        ts = user_msg.created_at.isoformat() if user_msg.created_at else ""

        # Echo to self
        await ws.send_json(_build_ws_frame("chat.message", {
            "session_id": session_id,
            "message": {
                "id": user_msg.id,
                "sender_id": user.id,
                "sender_type": "user",
                "sender_name": user.nickname,
                "content": content,
                "content_type": "text",
                "timestamp": ts,
                "is_me": True,
                "batch_id": None,
            }
        }))

        # ------------------------------------------------------------------
        # Private chat flow
        # ------------------------------------------------------------------
        if session_type == "private":
            target_id = None
            target_name = ""
            for m in member_rows:
                if m.member_id != user.id and m.member_type == "agent":
                    target_id = m.member_id
                    # lookup agent name
                    a = await db.execute(select(Agent).where(Agent.id == m.member_id))
                    agent = a.scalar_one_or_none()
                    if agent:
                        target_name = agent.name
                    break
            if target_id:
                await _stream_single_agent(
                    session_id=session_id,
                    agent_id=target_id,
                    agent_name=target_name,
                    user_message=content,
                    ws=ws,
                    broadcast_to=None,
                    source="private",
                    source_name=f"与{user.nickname}的私聊",
                    sender_name=user.nickname,
                )
            return

        # ------------------------------------------------------------------
        # Group chat flow
        # ------------------------------------------------------------------
        broadcast_frame = _build_ws_frame("chat.message", {
            "session_id": session_id,
            "message": {
                "id": user_msg.id,
                "sender_id": user.id,
                "sender_type": "user",
                "sender_name": user.nickname,
                "content": content,
                "content_type": "text",
                "timestamp": ts,
                "is_me": False,
                "batch_id": None,
            }
        })
        await manager.broadcast_to_session_members(other_members, broadcast_frame)

        # Conductor Q&A
        if conductor_id and ("@队长" in content or "@conductor" in content.lower()):
            state = _engine_state()
            bridge = EngineBridge(
                db=AsyncSessionLocal(),
                session_store=state["session_store"],
                context_manager=state["context_manager"],
                app_config=state["config"],
            )
            cond_svc = ConductorService(db=AsyncSessionLocal(), bridge=bridge)
            async for frame in cond_svc.handle_user_message(session, user.id, content):
                await ws.send_json(frame)
                await manager.broadcast_to_session_members(other_members, frame)
            return

        # Normal routing
        router = GroupChatRouter(db)
        targets = await router.route(session, user.id, content)
        if not targets:
            return

        # Build source name from session name or default
        source_name = session.name or (settings.get("name") if settings else None) or "群聊"

        tasks = []
        for t in targets:
            tasks.append(asyncio.create_task(_stream_single_agent(
                session_id=session_id,
                agent_id=t.agent_id,
                agent_name="",
                user_message=content,
                ws=ws,
                broadcast_to=other_members,
                source="group",
                source_name=source_name,
                sender_name=user.nickname,
            )))
        agent_replies = await asyncio.gather(*tasks, return_exceptions=True)

        # Intermind: if enabled, trigger other agents to respond to the first reply
        if settings.get("intermind_enabled", False):
            start_frame = {"type": "intermind.start", "payload": {"session_id": session_id}}
            await ws.send_json(start_frame)
            await manager.broadcast_to_session_members(other_members, start_frame)

            state = _engine_state()
            bridge = EngineBridge(
                db=AsyncSessionLocal(),
                session_store=state["session_store"],
                context_manager=state["context_manager"],
                app_config=state["config"],
            )
            cond_svc = ConductorService(db=AsyncSessionLocal(), bridge=bridge)
            for item in agent_replies:
                if isinstance(item, Exception):
                    logger.error("Agent reply failed: %s", item)
                    continue
                agent_id, reply_text = item
                if reply_text:
                    async for frame in cond_svc.maybe_trigger_intermind(session, agent_id, reply_text):
                        await ws.send_json(frame)
                        await manager.broadcast_to_session_members(other_members, frame)
                    break  # Only trigger once per user message to avoid explosion

            end_frame = {"type": "intermind.end", "payload": {"session_id": session_id}}
            await ws.send_json(end_frame)
            await manager.broadcast_to_session_members(other_members, end_frame)


# ------------------------------------------------------------------
# Agent stop handler (private chat only)
# ------------------------------------------------------------------
async def _handle_agent_stop(user: User, payload: dict, ws: WebSocket):
    session_id = payload.get("session_id", "")
    agent_id = payload.get("agent_id", "")
    if not session_id or not agent_id:
        return

    # Verify this is a private chat and user is a member
    async with AsyncSessionLocal() as db:
        sess_result = await db.execute(
            select(ChatSession).where(
                ChatSession.id == session_id,
                ChatSession.type == "private",
            )
        )
        session = sess_result.scalar_one_or_none()
        if not session:
            return

        mem = await db.execute(
            select(ChatSessionMember).where(
                ChatSessionMember.session_id == session_id,
                ChatSessionMember.member_id == user.id,
            )
        )
        if not mem.scalar_one_or_none():
            return

        # Set stop signal
        signal_key = f"{session_id}:{agent_id}"
        _set_stop_signal(signal_key)

        # Also signal the running Job via Worker
        from ..services.agent_worker import get_current_job
        job = get_current_job(agent_id)
        if job:
            job.stop_event.set()

        logger.info("Stop signal set for private chat %s agent %s", session_id, agent_id)


# ------------------------------------------------------------------
# Single agent stream (used by both private and group)
# ------------------------------------------------------------------
async def _stream_single_agent(
    session_id: str,
    agent_id: str,
    agent_name: str,
    user_message: str,
    ws: WebSocket,
    broadcast_to: list[ChatSessionMember] | None,
    source: str,
    source_name: str,
    sender_name: str,
) -> tuple[str, str]:
    state = _engine_state()
    bridge = EngineBridge(
        db=AsyncSessionLocal(),
        session_store=state["session_store"],
        context_manager=state["context_manager"],
        app_config=state["config"],
    )

    engine_session_id = f"{session_id}:{agent_id}"
    batch_id = str(uuid.uuid4())
    full_content = ""
    signal_key = f"{session_id}:{agent_id}"

    # Fallback agent name lookup
    if not agent_name:
        async with AsyncSessionLocal() as db:
            r = await db.execute(select(Agent).where(Agent.id == agent_id))
            a = r.scalar_one_or_none()
            agent_name = a.name if a else "Agent"

    # Clear stale stop signal
    _private_stop_signals.pop(signal_key, None)

    typing_frame = _build_ws_frame("chat.typing", {
        "session_id": session_id,
        "user_id": agent_id,
        "is_typing": True,
    })
    await ws.send_json(typing_frame)
    if broadcast_to:
        await manager.broadcast_to_session_members(broadcast_to, typing_frame)

    _has_error = False
    _error_msg = ""
    try:
        async for event in bridge.stream_chat(
            agent_id=agent_id,
            session_id=engine_session_id,
            user_message=user_message,
            source=source,
            source_name=source_name,
            sender_name=sender_name,
        ):
            # Check private stop signal
            if source == "private" and _check_stop_signal(signal_key):
                logger.info("Private chat stream stopped for %s", signal_key)
                stop_frame = _build_ws_frame("chat.message", {
                    "session_id": session_id,
                    "message": {
                        "id": str(uuid.uuid4()),
                        "sender_id": agent_id,
                        "sender_type": "system",
                        "sender_name": "系统",
                        "content": f"[{agent_name}] 已暂停",
                        "content_type": "text",
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                        "is_me": False,
                        "batch_id": batch_id,
                    }
                })
                await ws.send_json(stop_frame)
                if broadcast_to:
                    await manager.broadcast_to_session_members(broadcast_to, stop_frame)
                break

            if event.get("type") == "error":
                err_frame = _build_ws_frame("chat.message", {
                    "session_id": session_id,
                    "message": {
                        "id": str(uuid.uuid4()),
                        "sender_id": agent_id,
                        "sender_type": "agent",
                        "sender_name": agent_name,
                        "content": f"[Error] {event.get('message', '')}",
                        "content_type": "text",
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                        "is_me": False,
                        "batch_id": batch_id,
                    }
                })
                await ws.send_json(err_frame)
                if broadcast_to:
                    await manager.broadcast_to_session_members(broadcast_to, err_frame)
                break

            if event.get("type") == "content":
                text = event.get("data", {}).get("text", "")
                full_content += text
                chunk_frame = _build_ws_frame("chat.message", {
                    "session_id": session_id,
                    "message": {
                        "id": str(uuid.uuid4()),
                        "sender_id": agent_id,
                        "sender_type": "agent",
                        "sender_name": agent_name,
                        "content": text,
                        "content_type": "text",
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                        "is_me": False,
                        "batch_id": batch_id,
                    }
                })
                await ws.send_json(chunk_frame)
                if broadcast_to:
                    await manager.broadcast_to_session_members(broadcast_to, chunk_frame)

        # Persist
        if full_content:
            async with AsyncSessionLocal() as db2:
                assistant_msg = ChatMessage(
                    id=str(uuid.uuid4()),
                    session_id=session_id,
                    sender_id=agent_id,
                    sender_type="agent",
                    content=full_content,
                    content_type="text",
                    batch_id=batch_id,
                )
                db2.add(assistant_msg)
                await db2.commit()

    except Exception as exc:
        logger.exception("Agent stream failed for %s", agent_id)
        _has_error = True
        _error_msg = str(exc)

    finally:
        # Status is managed by AgentWorker; clear stop signal only
        _private_stop_signals.pop(signal_key, None)

        stop_typing = _build_ws_frame("chat.typing", {
            "session_id": session_id,
            "user_id": agent_id,
            "is_typing": False,
        })
        await ws.send_json(stop_typing)
        if broadcast_to:
            await manager.broadcast_to_session_members(broadcast_to, stop_typing)

        if _has_error:
            err_frame = _build_ws_frame("chat.message", {
                "session_id": session_id,
                "message": {
                    "id": str(uuid.uuid4()),
                    "sender_id": agent_id,
                    "sender_type": "system",
                    "sender_name": "系统",
                    "content": f"[{agent_name}] 回复失败: {_error_msg}",
                    "content_type": "text",
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "is_me": False,
                    "batch_id": None,
                }
            })
            await ws.send_json(err_frame)
            if broadcast_to:
                await manager.broadcast_to_session_members(broadcast_to, err_frame)

    return agent_id, full_content
