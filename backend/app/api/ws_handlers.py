"""WebSocket business handlers: chat, agent, typing, replay, memory sync."""

from __future__ import annotations

import asyncio
import logging
import re
import uuid
from datetime import datetime, timezone

from fastapi import WebSocket
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from ..database import AsyncSessionLocal
from ..models import Agent, ChatMessage, ChatSession, ChatSessionMember
from ..services.agent_worker import get_current_job
from ..services.engine_bridge import EngineBridge
from ..services.conductor_service import ConductorService
from ..services.event_bus import manager
from ..services.group_task_engine import GroupTaskEngine
from .ws_protocol import (
    _build_ws_frame,
    _check_stop_signal,
    _clear_stop_signal,
    _engine_state,
    _set_stop_signal,
)

from engine.agent.data_store import AgentDataStore

logger = logging.getLogger(__name__)

# Fixed user identifier for single-user local app
_USER_ID = "user"
_SENDER_NAME = "用户"

# ------------------------------------------------------------------
# Helpers for per-agent document storage
# ------------------------------------------------------------------
async def _get_private_agent_id(db, session_id: str) -> str | None:
    """Return the agent member id for a private session, or None."""
    result = await db.execute(
        select(ChatSessionMember).where(
            ChatSessionMember.session_id == session_id,
            ChatSessionMember.member_type == "agent",
        )
    )
    member = result.scalar_one_or_none()
    return member.member_id if member else None


async def _persist_message_to_agent_store(
    session_id: str,
    agent_id: str,
    msg_id: str,
    sender_id: str,
    sender_type: str,
    content: str,
    content_type: str = "text",
    reply_to: str | None = None,
    client_msg_id: str | None = None,
    batch_id: str | None = None,
    tool_calls: list | None = None,
    reasoning: str | None = None,
) -> dict:
    """Persist a chat message to the agent's document store."""
    store = AgentDataStore(agent_id)
    store.ensure_dirs()
    msg_record = {
        "id": msg_id,
        "session_id": session_id,
        "sender_id": sender_id,
        "sender_type": sender_type,
        "content": content,
        "content_type": content_type,
        "reply_to": reply_to,
        "client_msg_id": client_msg_id,
        "batch_id": batch_id,
        "tool_calls": tool_calls or [],
        "reasoning": reasoning or "",
        "is_deleted": False,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await asyncio.to_thread(store.append_message, session_id, msg_record)
    return msg_record


# ------------------------------------------------------------------
# Session-level task management for private chat (root fix for blocking)
# ------------------------------------------------------------------
# session_id -> asyncio.Task running _private_agent_worker
_private_agent_tasks: dict[str, asyncio.Task] = {}

# WebSocket instance id -> Lock for safe send_json
_ws_send_locks: dict[int, asyncio.Lock] = {}


# ------------------------------------------------------------------
# chat.send handler
# ------------------------------------------------------------------
async def _handle_chat_send(payload: dict, ws: WebSocket):
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
                ChatSessionMember.member_id == _USER_ID,
            )
        )
        if not mem.scalar_one_or_none():
            await ws.send_json(_build_ws_frame("error", {"message": "Not a member"}))
            return

        # Deduplicate by client_msg_id
        if client_msg_id:
            dup_found = False
            if session_type == "private":
                # Check agent's document store for private sessions
                target_id = None
                for m in member_rows:
                    if m.member_id != _USER_ID and m.member_type == "agent":
                        target_id = m.member_id
                        break
                if target_id:
                    msgs = await asyncio.to_thread(AgentDataStore(target_id).read_messages, session_id)
                    for msg in msgs:
                        if msg.get("client_msg_id") == client_msg_id:
                            dup_found = True
                            break
            if not dup_found:
                dup = await db.execute(
                    select(ChatMessage).where(
                        ChatMessage.session_id == session_id,
                        ChatMessage.client_msg_id == client_msg_id,
                    )
                )
                if dup.scalar_one_or_none():
                    dup_found = True
            if dup_found:
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
        other_members = [m for m in member_rows if m.member_id != _USER_ID]

        # Save user message
        user_msg_id = str(uuid.uuid4())
        ts = datetime.now(timezone.utc).isoformat()

        if session_type == "private":
            target_id = None
            for m in member_rows:
                if m.member_id != _USER_ID and m.member_type == "agent":
                    target_id = m.member_id
                    break
            if target_id:
                # Persist to agent's document store
                await _persist_message_to_agent_store(
                    session_id=session_id,
                    agent_id=target_id,
                    msg_id=user_msg_id,
                    sender_id=_USER_ID,
                    sender_type="user",
                    content=content,
                    content_type=content_type,
                    reply_to=reply_to,
                    client_msg_id=client_msg_id or None,
                )
                # Update session last_message_at in DB
                session.last_message_at = datetime.now(timezone.utc)
                await db.commit()
            else:
                # Fallback to DB if no agent found
                user_msg = ChatMessage(
                    id=user_msg_id,
                    session_id=session_id,
                    sender_id=_USER_ID,
                    sender_type="user",
                    content=content,
                    content_type=content_type,
                    reply_to=reply_to,
                    client_msg_id=client_msg_id or None,
                )
                db.add(user_msg)
                session.last_message_at = datetime.now(timezone.utc)
                await db.commit()
        else:
            # Group session: use shared DB
            user_msg = ChatMessage(
                id=user_msg_id,
                session_id=session_id,
                sender_id=_USER_ID,
                sender_type="user",
                content=content,
                content_type=content_type,
                reply_to=reply_to,
                client_msg_id=client_msg_id or None,
            )
            db.add(user_msg)
            session.last_message_at = datetime.now(timezone.utc)
            await db.commit()

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
                "id": user_msg_id,
                "sender_id": _USER_ID,
                "sender_type": "user",
                "sender_name": _SENDER_NAME,
                "content": content,
                "content_type": content_type,
                "timestamp": ts,
                "is_me": True,
                "batch_id": None,
            }
        }))

        # ------------------------------------------------------------------
        # Private chat flow (non-blocking: agent runs in background task)
        # ------------------------------------------------------------------
        if session_type == "private":
            target_id = None
            target_name = ""
            for m in member_rows:
                if m.member_id != _USER_ID and m.member_type == "agent":
                    target_id = m.member_id
                    a = await db.execute(select(Agent).where(Agent.id == m.member_id))
                    agent = a.scalar_one_or_none()
                    if agent:
                        target_name = agent.name
                    break
            if target_id:
                await _cancel_and_start_private_agent(
                    session_id=session_id,
                    agent_id=target_id,
                    agent_name=target_name,
                    user_message=content,
                    ws=ws,
                    sender_name=_SENDER_NAME,
                    user_id=_USER_ID,
                    content_type=content_type,
                )
            return

        # ------------------------------------------------------------------
        # Group chat flow
        # ------------------------------------------------------------------
        # Interrupt running task chain if any
        if GroupTaskEngine.is_running(session_id):
            GroupTaskEngine.stop_session(session_id)

        # Step 1: ingest message to ALL agents in the group (memory broadcast)
        for m in member_rows:
            if m.member_type == "agent":
                await _dispatch_ingest_to_agent(
                    agent_id=m.member_id,
                    user_message=content,
                    source_id=session_id,
                    source_name=session.name or "群聊",
                    sender_name=_SENDER_NAME,
                )

        broadcast_frame = _build_ws_frame("chat.message", {
            "session_id": session_id,
            "message": {
                "id": user_msg.id,
                "sender_id": _USER_ID,
                "sender_type": "user",
                "sender_name": _SENDER_NAME,
                "content": content,
                "content_type": content_type,
                "timestamp": ts,
                "is_me": False,
                "batch_id": None,
            }
        })
        await manager.broadcast_to_session_members(other_members, broadcast_frame)

        # Step 2: all agents decide autonomously via LLM (stay_silent supported)
        agent_member_ids = [m.member_id for m in member_rows if m.member_type == "agent"]
        agent_rows_result = await db.execute(
            select(Agent).where(Agent.id.in_(agent_member_ids))
        )
        agent_map = {a.id: a for a in agent_rows_result.scalars().all()}

        mention_tokens = set(re.findall(r"@(\S+)", content.lower()))
        is_all_mentioned = bool(mention_tokens & {"所有人", "all", "全体成员"})

        source_name = session.name or (settings.get("name") if settings else None) or "群聊"

        tasks = []
        mentioned_ids: list[str] = []
        for aid in agent_member_ids:
            agent = agent_map.get(aid)
            is_mentioned = is_all_mentioned or _is_agent_mentioned(agent, mention_tokens)
            if not is_mentioned and aid == session.conductor_agent_id and "队长" in mention_tokens:
                is_mentioned = True
            if is_mentioned:
                mentioned_ids.append(aid)

            tasks.append(asyncio.create_task(_stream_single_agent(
                session_id=session_id,
                agent_id=aid,
                agent_name=agent.name if agent else "",
                user_message=content,
                ws=ws,
                broadcast_to=other_members,
                source="group",
                source_name=source_name,
                sender_name=_SENDER_NAME,
                user_id=_USER_ID,
                content_type=content_type,
                is_mentioned=is_mentioned,
            )))

        logger.info("Group chat stream session=%s agents=%s mentioned=%s",
                    session_id, agent_member_ids, mentioned_ids)
        agent_replies = await asyncio.gather(*tasks, return_exceptions=True)

        # Intermind: if enabled, trigger other agents to respond to the first reply
        if settings.get("intermind_enabled", False):
            start_frame = {"type": "intermind.start", "payload": {"session_id": session_id}}
            await ws.send_json(start_frame)
            await manager.broadcast_to_session_members(other_members, start_frame)

            state = _engine_state()
            bridge = EngineBridge(
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
# Private chat agent task management (root fix: non-blocking WS loop)
# ------------------------------------------------------------------
async def _cancel_and_start_private_agent(
    session_id: str,
    agent_id: str,
    agent_name: str,
    user_message: str,
    ws: WebSocket,
    sender_name: str,
    user_id: str,
    content_type: str,
) -> None:
    """Cancel any running private agent task for this session and start a new one."""
    # 1. Cancel old background task
    old_task = _private_agent_tasks.get(session_id)
    if old_task and not old_task.done():
        old_task.cancel()
        try:
            await old_task
        except asyncio.CancelledError:
            pass

    # 2. Set stop signal for Worker-level job (double insurance)
    signal_key = f"{session_id}:{agent_id}"
    _set_stop_signal(signal_key)
    job = get_current_job(agent_id)
    if job and job.source == "private":
        job.stop_event.set()
        logger.info("Auto-interrupt private Job for agent %s", agent_id)

    # 3. Start new background task
    task = asyncio.create_task(_private_agent_worker(
        session_id=session_id,
        agent_id=agent_id,
        agent_name=agent_name,
        user_message=user_message,
        ws=ws,
        sender_name=sender_name,
        user_id=user_id,
        content_type=content_type,
    ))
    _private_agent_tasks[session_id] = task


async def _private_agent_worker(
    session_id: str,
    agent_id: str,
    agent_name: str,
    user_message: str,
    ws: WebSocket,
    sender_name: str,
    user_id: str,
    content_type: str,
) -> None:
    """Background task for private chat agent reply. Handles cancellation gracefully."""
    try:
        await _stream_single_agent(
            session_id=session_id,
            agent_id=agent_id,
            agent_name=agent_name,
            user_message=user_message,
            ws=ws,
            broadcast_to=None,
            source="private",
            source_name=f"与{sender_name}的私聊",
            sender_name=sender_name,
            user_id=user_id,
            content_type=content_type,
        )
    except asyncio.CancelledError:
        # Normal cancellation when user sends a new message
        pass
    finally:
        # Clean up task registry — only pop if we are still the current task
        current_task = asyncio.current_task()
        if _private_agent_tasks.get(session_id) is current_task:
            _private_agent_tasks.pop(session_id, None)


# ------------------------------------------------------------------
# Ingest helper (group chat — broadcast memory without reply)
# ------------------------------------------------------------------
async def _dispatch_ingest_to_agent(
    agent_id: str,
    user_message: str,
    source_id: str,
    source_name: str,
    sender_name: str,
) -> None:
    """Send an ingest-only Job to an agent's Worker queue.

    The Job goes through the same FIFO queue as stream Jobs,
    ensuring no concurrent access to _messages.
    """
    from ..services.job_queue import AgentJob
    from ..services.agent_worker import dispatch_job

    job = AgentJob(
        source="group",
        source_id=source_id,
        source_name=source_name,
        sender_name=sender_name,
        content=user_message,
        ingest_only=True,
        on_chunk=lambda _t: asyncio.sleep(0),
        on_done=lambda _t, _ok: asyncio.sleep(0),
    )
    await dispatch_job(agent_id, job)


# ------------------------------------------------------------------
# Agent stop handler (private chat only)
# ------------------------------------------------------------------
async def _handle_agent_stop(payload: dict, ws: WebSocket):
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
                ChatSessionMember.member_id == _USER_ID,
            )
        )
        if not mem.scalar_one_or_none():
            return

        # Set stop signal
        signal_key = f"{session_id}:{agent_id}"
        _set_stop_signal(signal_key)

        # Also signal the running Job via Worker
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
    content_type: str = "text",
    is_mentioned: bool = False,
) -> tuple[str, str]:
    state = _engine_state()
    bridge = EngineBridge(
        app_config=state["config"],
    )

    engine_session_id = f"{session_id}:{agent_id}"
    batch_id = str(uuid.uuid4())
    full_content = ""
    reasoning_parts: list[str] = []
    tool_calls_list: list[dict] = []
    signal_key = f"{session_id}:{agent_id}"

    # Fallback agent name lookup
    if not agent_name:
        async with AsyncSessionLocal() as db:
            r = await db.execute(select(Agent).where(Agent.id == agent_id))
            a = r.scalar_one_or_none()
            agent_name = a.name if a else "Agent"

    # Clear stale stop signal
    _clear_stop_signal(signal_key)

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
            content_type=content_type,
            is_mentioned=is_mentioned,
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
                reasoning_parts.append(thinking_text)
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
                tool_calls_list.append({"name": tool_name, "input": tool_input})
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
        if full_content or tool_calls_list or reasoning_parts:
            if source == "private":
                # Private chat: store in agent's document store
                await _persist_message_to_agent_store(
                    session_id=session_id,
                    agent_id=agent_id,
                    msg_id=str(uuid.uuid4()),
                    sender_id=agent_id,
                    sender_type="agent",
                    content=full_content,
                    content_type="text",
                    batch_id=batch_id,
                    tool_calls=tool_calls_list if tool_calls_list else None,
                    reasoning="\n".join(reasoning_parts) if reasoning_parts else None,
                )
            else:
                # Group chat: keep using shared DB for now
                async with AsyncSessionLocal() as db2:
                    assistant_msg = ChatMessage(
                        id=str(uuid.uuid4()),
                        session_id=session_id,
                        sender_id=agent_id,
                        sender_type="agent",
                        content=full_content,
                        content_type="text",
                        batch_id=batch_id,
                        tool_calls=tool_calls_list if tool_calls_list else None,
                        reasoning="\n".join(reasoning_parts) if reasoning_parts else None,
                    )
                    db2.add(assistant_msg)
                    await db2.commit()

    except Exception as exc:
        logger.exception("Agent stream failed for %s", agent_id)
        _has_error = True
        _error_msg = str(exc)

    finally:
        # Status is managed by AgentWorker; clear stop signal only
        _clear_stop_signal(signal_key)

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
            cutoff_iso = cutoff.isoformat() if cutoff else ""
            rows: list[dict] = []

            # Check session type
            sess_result = await db.execute(
                select(ChatSession).where(ChatSession.id == m.session_id)
            )
            session = sess_result.scalar_one_or_none()
            if not session:
                continue

            if session.type == "private":
                # Read from agent's document store
                agent_id = await _get_private_agent_id(db, m.session_id)
                if agent_id:
                    msgs = await asyncio.to_thread(AgentDataStore(agent_id).read_messages, m.session_id)
                    rows = [msg for msg in msgs if msg.get("created_at", "") > cutoff_iso and not msg.get("is_deleted")]
                    rows.sort(key=lambda r: r.get("created_at", ""))
                    # Resolve agent name from config
                    config = await asyncio.to_thread(AgentDataStore(agent_id).read_config)
                    agent_name = config.get("name", "Agent") if config else "Agent"
                    for r in rows:
                        sender_name = agent_name if r.get("sender_type") == "agent" else (
                            "系统" if r.get("sender_type") == "system" else "用户"
                        )
                        frame = _build_ws_frame("chat.message", {
                            "session_id": m.session_id,
                            "message": {
                                "id": r.get("id"),
                                "sender_id": r.get("sender_id"),
                                "sender_type": r.get("sender_type"),
                                "sender_name": sender_name,
                                "content": r.get("content"),
                                "content_type": r.get("content_type", "text"),
                                "timestamp": r.get("created_at", ""),
                                "is_me": r.get("sender_id") == user_id and r.get("sender_type") == "user",
                                "batch_id": r.get("batch_id"),
                                "tool_calls": r.get("tool_calls") or [],
                                "reasoning": r.get("reasoning") or "",
                            }
                        })
                        try:
                            await ws.send_json(frame)
                        except Exception:
                            continue
                    continue  # Skip DB fallback for private sessions

            # Fallback to shared DB for group sessions
            msg_result = await db.execute(
                select(ChatMessage).where(
                    ChatMessage.session_id == m.session_id,
                    ChatMessage.created_at > cutoff,
                    ChatMessage.is_deleted == False,
                ).order_by(ChatMessage.created_at.asc())
            )
            db_rows = msg_result.scalars().all()
            if not db_rows:
                continue

            # Batch resolve agent names
            agent_ids = {r.sender_id for r in db_rows if r.sender_type == "agent"}
            agent_names: dict[str, str] = {}
            if agent_ids:
                agent_res = await db.execute(
                    select(Agent.id, Agent.name).where(Agent.id.in_(agent_ids))
                )
                agent_names = {aid: name for aid, name in agent_res.all()}

            for r in db_rows:
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
                        "tool_calls": r.tool_calls or [],
                        "reasoning": r.reasoning or "",
                    }
                })
                try:
                    await ws.send_json(frame)
                except Exception:
                    # Continue with remaining offline messages even if one fails
                    continue


# ------------------------------------------------------------------
# User typing broadcast
# ------------------------------------------------------------------
async def _handle_typing(payload: dict, ws: WebSocket) -> None:
    session_id = payload.get("session_id", "")
    is_typing = payload.get("is_typing", False)

    async with AsyncSessionLocal() as db:
        # Verify membership
        mem = await db.execute(
            select(ChatSessionMember).where(
                ChatSessionMember.session_id == session_id,
                ChatSessionMember.member_id == _USER_ID,
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

        other_members = [m for m in session.members if m.member_id != _USER_ID]
        typing_frame = _build_ws_frame("chat.typing", {
            "session_id": session_id,
            "user_id": _USER_ID,
            "user_name": _SENDER_NAME,
            "is_typing": is_typing,
        })
        await manager.broadcast_to_session_members(other_members, typing_frame)


# ------------------------------------------------------------------
# Mention helper
# ------------------------------------------------------------------
def _is_agent_mentioned(agent: Agent | None, mention_tokens: set[str]) -> bool:
    if not agent:
        return False
    names = {agent.name, agent.codename} | set((agent.aliases or []))
    return bool(mention_tokens & {n.lower() for n in names if n})



