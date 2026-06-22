"""Chat REST API: sessions, messages."""

from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from ..dependencies import get_db
from ..models import Agent, ChatMessage, ChatSession, ChatSessionMember

from engine.agent.data_store import AgentDataStore

router = APIRouter(prefix="/chats", tags=["chat"])


# ------------------------------------------------------------------
# Schemas
# ------------------------------------------------------------------
class CreatePrivateReq(BaseModel):
    target_id: str
    target_type: str = "agent"  # agent | user


class SendMessageReq(BaseModel):
    content: str
    content_type: str = "text"
    reply_to: Optional[str] = None


class Resp(BaseModel):
    code: int = 0
    data: dict


# Fixed user id for single-user mode
_USER_ID = "user"


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------
async def _get_private_agent_id(db: AsyncSession, session_id: str) -> Optional[str]:
    """Return the agent member id for a private session, or None if not private/no agent."""
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
    reply_to: Optional[str] = None,
    client_msg_id: Optional[str] = None,
    batch_id: Optional[str] = None,
    tool_calls: Optional[list] = None,
    reasoning: Optional[str] = None,
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


async def _read_messages_from_agent_store(
    agent_id: str,
    session_id: str,
    before_timestamp: Optional[str] = None,
    search: Optional[str] = None,
    limit: int = 20,
) -> list[dict]:
    """Read messages from agent's document store with filtering."""
    store = AgentDataStore(agent_id)
    messages = await asyncio.to_thread(store.read_messages, session_id)
    # Filter out deleted
    messages = [m for m in messages if not m.get("is_deleted")]
    # Search filter
    if search:
        messages = [m for m in messages if search.lower() in m.get("content", "").lower()]
    # Before timestamp filter
    if before_timestamp:
        messages = [m for m in messages if m.get("created_at", "") < before_timestamp]
    # Sort by created_at desc, then take limit, then reverse for ascending order
    messages.sort(key=lambda m: m.get("created_at", ""), reverse=True)
    messages = messages[:limit]
    messages.reverse()
    return messages


async def _ensure_private_session(
    db: AsyncSession, target_id: str, target_type: str
) -> ChatSession:
    """Find or create a private session between user and target."""
    # Query existing private sessions where user is a member
    stmt = (
        select(ChatSession)
        .join(ChatSessionMember, ChatSessionMember.session_id == ChatSession.id)
        .where(
            ChatSession.type == "private",
            ChatSessionMember.member_id == _USER_ID,
            ChatSessionMember.member_type == "user",
        )
        .options(selectinload(ChatSession.members))
    )
    result = await db.execute(stmt)
    candidates = result.scalars().all()

    for sess in candidates:
        # Check if target is also a member
        for m in sess.members:
            if m.member_id == target_id and m.member_type == target_type:
                return sess

    # Create new
    sess = ChatSession(
        id=str(uuid.uuid4()),
        type="private",
        owner_id=_USER_ID,
    )
    db.add(sess)
    await db.flush()

    # Add members
    db.add(ChatSessionMember(session_id=sess.id, member_id=_USER_ID, member_type="user"))
    db.add(ChatSessionMember(session_id=sess.id, member_id=target_id, member_type=target_type))
    await db.commit()
    await db.refresh(sess)
    return sess


# ------------------------------------------------------------------
# Routes
# ------------------------------------------------------------------
@router.post("/sessions/private", response_model=Resp)
async def create_or_get_private(
    body: CreatePrivateReq,
    db: AsyncSession = Depends(get_db),
):
    sess = await _ensure_private_session(db, body.target_id, body.target_type)

    # Get target name/avatar
    target_name = "Unknown"
    target_avatar = ""
    if body.target_type == "agent":
        from ..services.agent_resolver import get_agent_config
        config = get_agent_config(body.target_id)
        if config:
            target_name = config.get("name", "Unknown")
            target_avatar = config.get("portrait_url", "")

    return Resp(
        data={
            "session_id": sess.id,
            "type": "private",
            "target_id": body.target_id,
            "target_type": body.target_type,
            "target_name": target_name,
            "target_avatar": target_avatar,
        }
    )


@router.get("/sessions", response_model=Resp)
async def list_sessions(
    type: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
):
    # 1. Load session memberships (no eager messages)
    stmt = (
        select(ChatSession, ChatSessionMember)
        .join(ChatSessionMember, ChatSessionMember.session_id == ChatSession.id)
        .where(
            ChatSessionMember.member_id == _USER_ID,
            ChatSessionMember.member_type == "user",
            ChatSession.status != "dissolved",
        )
    )
    if type:
        stmt = stmt.where(ChatSession.type == type)

    stmt = stmt.order_by(ChatSessionMember.is_pinned.desc(), ChatSession.last_message_at.desc().nullslast())
    stmt = stmt.options(selectinload(ChatSession.members))
    result = await db.execute(stmt)
    rows = result.all()

    if not rows:
        return Resp(data={"items": []})

    session_ids = [sess.id for sess, _ in rows]

    # 2. Load latest message and unread count per session
    # For private sessions, read from agent document stores
    # For group sessions, use shared DB
    latest_by_session: dict[str, Any] = {}
    unread_by_session: dict[str, int] = {}

    private_session_ids = [sess.id for sess, _ in rows if sess.type == "private"]
    group_session_ids = [sess.id for sess, _ in rows if sess.type == "group"]

    # Group sessions: use DB queries
    if group_session_ids:
        latest_subq = (
            select(
                ChatMessage.session_id,
                ChatMessage.id.label("msg_id"),
                ChatMessage.content,
                ChatMessage.sender_id,
                ChatMessage.is_deleted,
                ChatMessage.created_at,
                func.row_number().over(
                    partition_by=ChatMessage.session_id,
                    order_by=ChatMessage.created_at.desc(),
                ).label("rn"),
            )
            .where(ChatMessage.session_id.in_(group_session_ids))
            .subquery()
        )
        latest_stmt = select(latest_subq).where(latest_subq.c.rn == 1)
        latest_result = await db.execute(latest_stmt)
        for row in latest_result.mappings():
            latest_by_session[row["session_id"]] = row

        unread_stmt = (
            select(ChatMessage.session_id, func.count().label("cnt"))
            .where(
                ChatMessage.session_id.in_(group_session_ids),
                ChatMessage.sender_id != _USER_ID,
                ChatMessage.is_deleted == False,
            )
            .group_by(ChatMessage.session_id)
        )
        unread_result = await db.execute(unread_stmt)
        unread_by_session.update({row[0]: row[1] for row in unread_result.all()})

    # Private sessions: read from agent document stores
    for sess, member in rows:
        if sess.type != "private":
            continue
        agent_id = None
        for m in sess.members:
            if m.member_id != _USER_ID and m.member_type == "agent":
                agent_id = m.member_id
                break
        if not agent_id:
            continue
        msgs = await asyncio.to_thread(AgentDataStore(agent_id).read_messages, sess.id)
        if not msgs:
            continue
        # Filter deleted
        msgs = [m for m in msgs if not m.get("is_deleted")]
        if not msgs:
            continue
        # Sort by created_at desc to get latest
        msgs.sort(key=lambda m: m.get("created_at", ""), reverse=True)
        latest = msgs[0]
        latest_by_session[sess.id] = {
            "session_id": sess.id,
            "msg_id": latest.get("id"),
            "content": latest.get("content"),
            "sender_id": latest.get("sender_id"),
            "is_deleted": latest.get("is_deleted", False),
            "created_at": latest.get("created_at"),
        }
        # Unread count: messages after member.last_read_at
        last_read = member.last_read_at.isoformat() if member.last_read_at else None
        if last_read:
            unread_count = sum(
                1 for m in msgs
                if m.get("sender_id") != _USER_ID and m.get("created_at", "") > last_read
            )
        else:
            unread_count = sum(1 for m in msgs if m.get("sender_id") != _USER_ID)
        unread_by_session[sess.id] = unread_count

    # 3. Bulk load agent names/avatars for private sessions
    private_agent_ids = {
        m.member_id
        for sess, _ in rows
        if sess.type == "private"
        for m in sess.members
        if m.member_id != _USER_ID and m.member_type == "agent"
    }
    agents_by_id: dict[str, dict] = {}
    if private_agent_ids:
        from ..services.agent_resolver import get_agents_by_ids
        agents_by_id = get_agents_by_ids(list(private_agent_ids))

    items = []
    for sess, member in rows:
        other_name = ""
        other_avatar = ""
        if sess.type == "private":
            for m in sess.members:
                if m.member_id != _USER_ID and m.member_type == "agent":
                    a = agents_by_id.get(m.member_id)
                    if a:
                        other_name = a.get("name", "")
                        other_avatar = a.get("portrait_url", "")
                    break

        latest = latest_by_session.get(sess.id)
        last_msg = None
        if latest:
            content = latest["content"] or ""
            last_msg = {
                "content": content[:100],
                "timestamp": latest["created_at"].isoformat() if latest["created_at"] else "",
                "is_unread": latest["sender_id"] != _USER_ID and not latest["is_deleted"],
            }

        group_avatar = ""
        group_name = ""
        if sess.type == "group":
            group_avatar = (sess.settings or {}).get("avatar_url", "")
            group_name = sess.name or "未命名群组"

        items.append({
            "session_id": sess.id,
            "type": sess.type,
            "target_id": next((m.member_id for m in sess.members if m.member_id != _USER_ID), None),
            "target_type": next((m.member_type for m in sess.members if m.member_id != _USER_ID), None),
            "target_name": other_name or group_name,
            "target_avatar": other_avatar or group_avatar,
            "last_message": last_msg,
            "unread_count": unread_by_session.get(sess.id, 0),
            "is_pinned": member.is_pinned,
        })

    return Resp(data={"items": items})


@router.get("/sessions/{session_id}/messages", response_model=Resp)
async def get_messages(
    session_id: str,
    before_id: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    limit: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
):
    # Verify membership
    mem = await db.execute(
        select(ChatSessionMember).where(
            ChatSessionMember.session_id == session_id,
            ChatSessionMember.member_id == _USER_ID,
        )
    )
    if not mem.scalar_one_or_none():
        raise HTTPException(status_code=403, detail="Not a member of this session")

    # Determine session type and agent
    sess_result = await db.execute(
        select(ChatSession).where(ChatSession.id == session_id)
    )
    session = sess_result.scalar_one_or_none()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    if session.type == "private":
        agent_id = await _get_private_agent_id(db, session_id)
        if agent_id:
            # Read from agent's document store
            before_timestamp = None
            if before_id:
                # Find timestamp of before_id in agent store
                msgs = await asyncio.to_thread(AgentDataStore(agent_id).read_messages, session_id)
                for m in msgs:
                    if m.get("id") == before_id:
                        before_timestamp = m.get("created_at")
                        break
            rows = await _read_messages_from_agent_store(
                agent_id, session_id, before_timestamp=before_timestamp, search=search, limit=limit
            )
            # Resolve agent names from document store config
            agent_names = {}
            config = await asyncio.to_thread(AgentDataStore(agent_id).read_config)
            if config:
                agent_names[agent_id] = config.get("name", "Agent")
            reply_ids = {m.get("reply_to") for m in rows if m.get("reply_to")}
            reply_map = {}
            if reply_ids:
                all_msgs = await asyncio.to_thread(AgentDataStore(agent_id).read_messages, session_id)
                for rmsg in all_msgs:
                    if rmsg.get("id") in reply_ids:
                        reply_map[rmsg["id"]] = {
                            "id": rmsg["id"],
                            "sender_id": rmsg.get("sender_id"),
                            "sender_type": rmsg.get("sender_type"),
                            "content": rmsg.get("content", "")[:120] + "..." if len(rmsg.get("content", "")) > 120 else rmsg.get("content", ""),
                            "content_type": rmsg.get("content_type", "text"),
                        }
            def _sender_name(msg: dict) -> str:
                if msg.get("sender_type") == "agent":
                    return agent_names.get(msg.get("sender_id"), "Agent")
                return "User" if msg.get("sender_id") == _USER_ID else "User"
            messages = [
                {
                    "id": m["id"],
                    "sender_id": m.get("sender_id"),
                    "sender_type": m.get("sender_type"),
                    "sender_name": _sender_name(m),
                    "content": m.get("content"),
                    "content_type": m.get("content_type", "text"),
                    "reply_to": reply_map.get(m.get("reply_to")) if m.get("reply_to") else None,
                    "timestamp": m.get("created_at", ""),
                    "is_me": m.get("sender_id") == _USER_ID and m.get("sender_type") == "user",
                    "batch_id": m.get("batch_id"),
                    "tool_calls": m.get("tool_calls") or [],
                    "reasoning": m.get("reasoning") or "",
                }
                for m in rows
            ]
            return Resp(data={"items": messages})

    # Fallback to shared DB for group sessions or if private session has no agent
    stmt = (
        select(ChatMessage)
        .where(ChatMessage.session_id == session_id, ChatMessage.is_deleted == False)
        .order_by(ChatMessage.created_at.desc())
    )
    if search:
        stmt = stmt.where(ChatMessage.content.ilike(f"%{search}%"))
    if before_id:
        # Find timestamp of before_id
        bm = await db.execute(select(ChatMessage).where(ChatMessage.id == before_id))
        bm_row = bm.scalar_one_or_none()
        if bm_row and bm_row.created_at:
            stmt = stmt.where(ChatMessage.created_at < bm_row.created_at)

    result = await db.execute(stmt.limit(limit))
    rows = result.scalars().all()

    # Batch resolve agent names
    agent_ids = {m.sender_id for m in rows if m.sender_type == "agent"}
    agent_names: dict[str, str] = {}
    if agent_ids:
        from ..models import Agent
        agent_res = await db.execute(select(Agent.id, Agent.name).where(Agent.id.in_(agent_ids)))
        agent_names = {aid: name for aid, name in agent_res.all()}

    # Batch resolve reply_to messages
    reply_ids = {m.reply_to for m in rows if m.reply_to}
    reply_map: dict[str, dict] = {}
    if reply_ids:
        reply_res = await db.execute(
            select(ChatMessage).where(ChatMessage.id.in_(reply_ids))
        )
        for rmsg in reply_res.scalars().all():
            reply_map[rmsg.id] = {
                "id": rmsg.id,
                "sender_id": rmsg.sender_id,
                "sender_type": rmsg.sender_type,
                "content": rmsg.content[:120] + "..." if len(rmsg.content) > 120 else rmsg.content,
                "content_type": rmsg.content_type,
            }

    def _sender_name(msg: ChatMessage) -> str:
        if msg.sender_type == "agent":
            return agent_names.get(msg.sender_id, "Agent")
        return "User" if msg.sender_id == _USER_ID else "User"

    messages = [
        {
            "id": m.id,
            "sender_id": m.sender_id,
            "sender_type": m.sender_type,
            "sender_name": _sender_name(m),
            "content": m.content,
            "content_type": m.content_type,
            "reply_to": reply_map.get(m.reply_to) if m.reply_to else None,
            "timestamp": m.created_at.isoformat() if m.created_at else "",
            "is_me": m.sender_id == _USER_ID and m.sender_type == "user",
            "batch_id": m.batch_id,
            "tool_calls": m.tool_calls or [],
            "reasoning": m.reasoning or "",
        }
        for m in reversed(rows)
    ]

    return Resp(data={"items": messages})


@router.post("/sessions/{session_id}/messages", response_model=Resp)
async def send_message_http(
    session_id: str,
    body: SendMessageReq,
    db: AsyncSession = Depends(get_db),
):
    mem = await db.execute(
        select(ChatSessionMember).where(
            ChatSessionMember.session_id == session_id,
            ChatSessionMember.member_id == _USER_ID,
        )
    )
    if not mem.scalar_one_or_none():
        raise HTTPException(status_code=403, detail="Not a member")

    # Get session type
    sess_result = await db.execute(
        select(ChatSession).where(ChatSession.id == session_id)
    )
    session = sess_result.scalar_one_or_none()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    msg_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc)

    if session.type == "private":
        agent_id = await _get_private_agent_id(db, session_id)
        if agent_id:
            # Persist to agent's document store
            msg_record = await _persist_message_to_agent_store(
                session_id=session_id,
                agent_id=agent_id,
                msg_id=msg_id,
                sender_id=_USER_ID,
                sender_type="user",
                content=body.content,
                content_type=body.content_type,
                reply_to=body.reply_to,
            )
            # Update session last_message_at in DB
            session.last_message_at = now
            await db.commit()
            return Resp(
                data={
                    "id": msg_id,
                    "sender_id": _USER_ID,
                    "content": body.content,
                    "timestamp": msg_record["created_at"],
                }
            )

    # Fallback to shared DB for group sessions or if no agent found
    msg = ChatMessage(
        id=msg_id,
        session_id=session_id,
        sender_id=_USER_ID,
        sender_type="user",
        content=body.content,
        content_type=body.content_type,
        reply_to=body.reply_to,
    )
    db.add(msg)

    # Update session last_message_at
    session.last_message_at = now
    await db.commit()
    return Resp(
        data={
            "id": msg.id,
            "sender_id": msg.sender_id,
            "content": msg.content,
            "timestamp": msg.created_at.isoformat() if msg.created_at else "",
        }
    )


class PinReq(BaseModel):
    pinned: bool = True

@router.put("/sessions/{session_id}/pin", response_model=Resp)
async def pin_session(
    session_id: str,
    body: PinReq,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(ChatSessionMember).where(
            ChatSessionMember.session_id == session_id,
            ChatSessionMember.member_id == _USER_ID,
            ChatSessionMember.member_type == "user",
        )
    )
    member = result.scalar_one_or_none()
    if not member:
        raise HTTPException(status_code=403, detail="Not a member")
    member.is_pinned = body.pinned
    await db.commit()
    return Resp(data={"pinned": body.pinned})


@router.put("/sessions/{session_id}/read", response_model=Resp)
async def mark_read(
    session_id: str,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(ChatSessionMember).where(
            ChatSessionMember.session_id == session_id,
            ChatSessionMember.member_id == _USER_ID,
            ChatSessionMember.member_type == "user",
        )
    )
    member = result.scalar_one_or_none()
    if not member:
        raise HTTPException(status_code=403, detail="Not a member")
    member.last_read_at = datetime.now(timezone.utc)
    await db.commit()
    return Resp(data={"read": True})
