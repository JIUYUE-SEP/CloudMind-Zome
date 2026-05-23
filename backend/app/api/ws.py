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
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from ..database import AsyncSessionLocal
from ..dependencies import require_user
from ..models import Agent, ChatMessage, ChatSession, ChatSessionMember, User
from ..services.engine_bridge import EngineBridge
from ..services.group_chat_router import GroupChatRouter
from ..services.conductor_service import ConductorService
from ..services.event_bus import manager
from ..services.group_task_engine import GroupTaskEngine
from ..services.intimacy import add_score
from ..services.proactive_wake_scheduler import send_offline_wake

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
async def websocket_endpoint(ws: WebSocket):
    async with AsyncSessionLocal() as db:
        user = await _get_user_from_token(None, db)

    # Guest users are always accepted thanks to _get_user_from_token fallback

    await manager.connect(user.id, ws)
    await ws.send_json({"type": "auth.success", "payload": {"user_id": user.id}})
    await send_offline_wake(user.id, ws)

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
                await _handle_chat_send(user, payload, ws)
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


# ------------------------------------------------------------------
# chat.send handler
# ------------------------------------------------------------------
async def _handle_chat_send(user: User, payload: dict, ws: WebSocket):
    session_id = payload.get("session_id", "")
    content = payload.get("content", "")
    client_msg_id = payload.get("client_msg_id", "")
    content_type = payload.get("content_type", "text")
    reply_to = payload.get("reply_to", None)

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

        # Deduplicate by client_msg_id
        if client_msg_id:
            dup = await db.execute(
                select(ChatMessage).where(
                    ChatMessage.session_id == session_id,
                    ChatMessage.client_msg_id == client_msg_id,
                )
            )
            if dup.scalar_one_or_none():
                await ws.send_json(_build_ws_frame("chat.ack", {
                    "session_id": session_id,
                    "client_msg_id": client_msg_id,
                    "status": "dedup",
                }))
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
            content_type=content_type,
            reply_to=reply_to,
            client_msg_id=client_msg_id or None,
        )
        db.add(user_msg)
        session.last_message_at = datetime.now(timezone.utc)
        await db.commit()

        ts = user_msg.created_at.isoformat() if user_msg.created_at else ""

        # ACK
        if client_msg_id:
            await ws.send_json(_build_ws_frame("chat.ack", {
                "session_id": session_id,
                "client_msg_id": client_msg_id,
                "status": "ok",
            }))

        # Echo to self
        await ws.send_json(_build_ws_frame("chat.message", {
            "session_id": session_id,
            "message": {
                "id": user_msg.id,
                "sender_id": user.id,
                "sender_type": "user",
                "sender_name": user.nickname,
                "content": content,
                "content_type": content_type,
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
                # Intimacy: user sends msg in private chat
                await add_score(target_id, user.id, "private_user_msg")
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
                    user_id=user.id,
                )
            return

        # ------------------------------------------------------------------
        # Group chat flow
        # ------------------------------------------------------------------
        # Interrupt running task chain if any
        if GroupTaskEngine.is_running(session_id):
            GroupTaskEngine.stop_session(session_id)

        broadcast_frame = _build_ws_frame("chat.message", {
            "session_id": session_id,
            "message": {
                "id": user_msg.id,
                "sender_id": user.id,
                "sender_type": "user",
                "sender_name": user.nickname,
                "content": content,
                "content_type": content_type,
                "timestamp": ts,
                "is_me": False,
                "batch_id": None,
            }
        })
        await manager.broadcast_to_session_members(other_members, broadcast_frame)

        # Normal routing
        router = GroupChatRouter(db)
        targets = await router.route(session, user.id, content)
        logger.info("Group chat routing session=%s mode=%s targets=%s",
                    session_id, (session.settings or {}).get("routing_mode", "intent"),
                    [t.agent_id for t in targets])
        if not targets:
            no_reply_frame = _build_ws_frame("chat.message", {
                "session_id": session_id,
                "message": {
                    "id": str(uuid.uuid4()),
                    "sender_id": "system",
                    "sender_type": "system",
                    "sender_name": "系统",
                    "content": "【没有 Agent 被选中回复。尝试 @某个Agent 或检查群聊路由设置】",
                    "content_type": "text",
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "is_me": False,
                    "batch_id": None,
                }
            })
            await ws.send_json(no_reply_frame)
            if other_members:
                await manager.broadcast_to_session_members(other_members, no_reply_frame)
            return

        # Intimacy: group chat user msg triggers agents
        for t in targets:
            if t.reason == "mention":
                await add_score(t.agent_id, user.id, "group_mention")

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
                user_id=user.id,
            )))
        agent_replies = await asyncio.gather(*tasks, return_exceptions=True)

        # Intermind: if enabled, trigger other agents to respond to the first reply
        if settings.get("intermind_enabled", False):
            start_frame = {"type": "intermind.start", "payload": {"session_id": session_id}}
            await ws.send_json(start_frame)
            await manager.broadcast_to_session_members(other_members, start_frame)

            state = _engine_state()
            bridge = EngineBridge(
                session_store=state["session_store"],
                context_manager=state["context_manager"],
                app_config=state["config"],
            )
            cond_svc = ConductorService(bridge=bridge)
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
    user_id: str = "",
) -> tuple[str, str]:
    state = _engine_state()
    bridge = EngineBridge(
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

            elif event.get("type") == "thinking":
                thinking_text = event.get("data", {}).get("thinking", "")
                thinking_frame = _build_ws_frame("chat.thinking", {
                    "session_id": session_id,
                    "agent_id": agent_id,
                    "agent_name": agent_name,
                    "thinking": thinking_text,
                    "batch_id": batch_id,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                })
                await ws.send_json(thinking_frame)
                if broadcast_to:
                    await manager.broadcast_to_session_members(broadcast_to, thinking_frame)

            elif event.get("type") == "tool_call":
                tool_name = event.get("data", {}).get("name", "")
                tool_input = event.get("data", {}).get("input", {})
                tool_frame = _build_ws_frame("chat.tool_call", {
                    "session_id": session_id,
                    "agent_id": agent_id,
                    "agent_name": agent_name,
                    "tool_name": tool_name,
                    "tool_input": tool_input,
                    "batch_id": batch_id,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                })
                await ws.send_json(tool_frame)
                if broadcast_to:
                    await manager.broadcast_to_session_members(broadcast_to, tool_frame)

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

            # Cross-agent memory: let every agent in the group see this exchange
            if source == "group" and user_id:
                await _sync_group_memory(session_id, agent_id, user_message, full_content, sender_name)

            # Intimacy: agent replied
            if user_id:
                event_key = "private_agent_reply" if source == "private" else "group_mention"
                await add_score(agent_id, user_id, event_key)

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


# ------------------------------------------------------------------
# Offline message replay
# ------------------------------------------------------------------
async def _replay_offline_messages(user_id: str, ws: WebSocket) -> None:
    """Push messages received while user was offline."""
    async with AsyncSessionLocal() as db:
        # Find all sessions where user is member and has disconnect time
        result = await db.execute(
            select(ChatSessionMember).where(
                ChatSessionMember.member_id == user_id,
                ChatSessionMember.member_type == "user",
                ChatSessionMember.last_disconnect_at.isnot(None),
            )
        )
        members = result.scalars().all()

        for m in members:
            cutoff = m.last_disconnect_at
            # Fetch messages after disconnect
            msg_result = await db.execute(
                select(ChatMessage).where(
                    ChatMessage.session_id == m.session_id,
                    ChatMessage.created_at > cutoff,
                    ChatMessage.is_deleted == False,
                ).order_by(ChatMessage.created_at.asc())
            )
            rows = msg_result.scalars().all()
            if not rows:
                continue

            # Batch resolve agent names
            agent_ids = {r.sender_id for r in rows if r.sender_type == "agent"}
            agent_names: dict[str, str] = {}
            if agent_ids:
                agent_res = await db.execute(
                    select(Agent.id, Agent.name).where(Agent.id.in_(agent_ids))
                )
                agent_names = {aid: name for aid, name in agent_res.all()}

            for r in rows:
                sender_name = agent_names.get(r.sender_id, "Agent") if r.sender_type == "agent" else (
                    "系统" if r.sender_type == "system" else "用户"
                )
                frame = _build_ws_frame("chat.message", {
                    "session_id": m.session_id,
                    "message": {
                        "id": r.id,
                        "sender_id": r.sender_id,
                        "sender_type": r.sender_type,
                        "sender_name": sender_name,
                        "content": r.content,
                        "content_type": r.content_type,
                        "timestamp": r.created_at.isoformat() if r.created_at else "",
                        "is_me": r.sender_id == user_id and r.sender_type == "user",
                        "batch_id": r.batch_id,
                    }
                })
                try:
                    await ws.send_json(frame)
                except Exception:
                    break


# ------------------------------------------------------------------
# User typing broadcast
# ------------------------------------------------------------------
async def _handle_typing(user: User, payload: dict, ws: WebSocket) -> None:
    session_id = payload.get("session_id", "")
    is_typing = payload.get("is_typing", False)

    async with AsyncSessionLocal() as db:
        # Verify membership
        mem = await db.execute(
            select(ChatSessionMember).where(
                ChatSessionMember.session_id == session_id,
                ChatSessionMember.member_id == user.id,
            )
        )
        if not mem.scalar_one_or_none():
            return

        # Load other members
        sess_result = await db.execute(
            select(ChatSession).where(ChatSession.id == session_id)
            .options(selectinload(ChatSession.members))
        )
        session = sess_result.scalar_one_or_none()
        if not session:
            return

        other_members = [m for m in session.members if m.member_id != user.id]
        typing_frame = _build_ws_frame("chat.typing", {
            "session_id": session_id,
            "user_id": user.id,
            "user_name": user.nickname,
            "is_typing": is_typing,
        })
        await manager.broadcast_to_session_members(other_members, typing_frame)


# ------------------------------------------------------------------
# Cross-agent memory sync
# ------------------------------------------------------------------
async def _sync_group_memory(
    session_id: str,
    replying_agent_id: str,
    user_message: str,
    agent_reply: str,
    sender_name: str,
) -> None:
    """Save this exchange to every other agent's memory in the group."""
    try:
        state = _engine_state()
        store = state.get("session_store")
        if not store:
            return

        async with AsyncSessionLocal() as db:
            # Get all agent members except the replying one
            result = await db.execute(
                select(ChatSessionMember).where(
                    ChatSessionMember.session_id == session_id,
                    ChatSessionMember.member_type == "agent",
                    ChatSessionMember.member_id != replying_agent_id,
                )
            )
            other_agents = [r.member_id for r in result.scalars().all()]

            if not other_agents:
                return

            # Resolve replying agent's name
            ar = await db.execute(select(Agent).where(Agent.id == replying_agent_id))
            agent_row = ar.scalar_one_or_none()
            agent_name = agent_row.name if agent_row else "Agent"

        from engine.message.types import Message, MessageMeta
        import time

        now = time.time()

        for other_id in other_agents:
            engine_sid = f"{session_id}:{other_id}"
            # Save user message
            user_msg = Message(
                role="user",
                content=user_message,
                meta=MessageMeta(
                    session_id=engine_sid,
                    source="group",
                    source_name="群聊",
                    sender_name=sender_name,
                    timestamp=now,
                ),
            )
            # Save agent reply — stored as user-role because from this agent's
            # perspective, someone else (not themselves) said it.
            agent_msg = Message(
                role="user",
                content=agent_reply,
                meta=MessageMeta(
                    session_id=engine_sid,
                    source="group",
                    source_name="群聊",
                    sender_name=agent_name,
                    timestamp=now + 0.001,
                ),
            )
            try:
                await store.save_agent_message(
                    user_msg, agent_id=other_id, source="group",
                    source_id=engine_sid, source_name="群聊", sender_name=sender_name,
                )
                await store.save_agent_message(
                    agent_msg, agent_id=other_id, source="group",
                    source_id=engine_sid, source_name="群聊", sender_name=agent_name,
                )
            except Exception:
                pass

    except Exception:
        logger.exception("Cross-agent memory sync failed")
