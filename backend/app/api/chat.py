"""Chat REST API: sessions, messages."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from ..dependencies import get_db, require_user
from ..models import Agent, ChatMessage, ChatSession, ChatSessionMember, User

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


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------
async def _ensure_private_session(
    db: AsyncSession, user_id: str, target_id: str, target_type: str
) -> ChatSession:
    """Find or create a private session between user and target."""
    # Query existing private sessions where user is a member
    stmt = (
        select(ChatSession)
        .join(ChatSessionMember, ChatSessionMember.session_id == ChatSession.id)
        .where(
            ChatSession.type == "private",
            ChatSessionMember.member_id == user_id,
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
        owner_id=user_id,
    )
    db.add(sess)
    await db.flush()

    # Add members
    db.add(ChatSessionMember(session_id=sess.id, member_id=user_id, member_type="user"))
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
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    sess = await _ensure_private_session(db, user.id, body.target_id, body.target_type)

    # Get target name/avatar
    target_name = "Unknown"
    target_avatar = ""
    if body.target_type == "agent":
        r = await db.execute(select(Agent).where(Agent.id == body.target_id))
        a = r.scalar_one_or_none()
        if a:
            target_name = a.name
            target_avatar = a.portrait_url or ""

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
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    # 1. Load session memberships (no eager messages)
    stmt = (
        select(ChatSession, ChatSessionMember)
        .join(ChatSessionMember, ChatSessionMember.session_id == ChatSession.id)
        .where(
            ChatSessionMember.member_id == user.id,
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

    # 2. Load latest message and unread count per session with single queries
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
        .where(ChatMessage.session_id.in_(session_ids))
        .subquery()
    )

    latest_stmt = select(latest_subq).where(latest_subq.c.rn == 1)
    latest_result = await db.execute(latest_stmt)
    latest_by_session: dict[str, Any] = {}
    for row in latest_result.mappings():
        latest_by_session[row["session_id"]] = row

    unread_stmt = (
        select(ChatMessage.session_id, func.count().label("cnt"))
        .where(
            ChatMessage.session_id.in_(session_ids),
            ChatMessage.sender_id != user.id,
            ChatMessage.is_deleted == False,
        )
        .group_by(ChatMessage.session_id)
    )
    unread_result = await db.execute(unread_stmt)
    unread_by_session = {row[0]: row[1] for row in unread_result.all()}

    # 3. Bulk load agent names/avatars for private sessions
    private_agent_ids = {
        m.member_id
        for sess, _ in rows
        if sess.type == "private"
        for m in sess.members
        if m.member_id != user.id and m.member_type == "agent"
    }
    agents_by_id: dict[str, Agent] = {}
    if private_agent_ids:
        agent_result = await db.execute(select(Agent).where(Agent.id.in_(private_agent_ids)))
        agents_by_id = {a.id: a for a in agent_result.scalars().all()}

    items = []
    for sess, member in rows:
        other_name = ""
        other_avatar = ""
        if sess.type == "private":
            for m in sess.members:
                if m.member_id != user.id and m.member_type == "agent":
                    a = agents_by_id.get(m.member_id)
                    if a:
                        other_name = a.name
                        other_avatar = a.portrait_url or ""
                    break

        latest = latest_by_session.get(sess.id)
        last_msg = None
        if latest:
            content = latest["content"] or ""
            last_msg = {
                "content": content[:100],
                "timestamp": latest["created_at"].isoformat() if latest["created_at"] else "",
                "is_unread": latest["sender_id"] != user.id and not latest["is_deleted"],
            }

        group_avatar = ""
        group_name = ""
        if sess.type == "group":
            group_avatar = (sess.settings or {}).get("avatar_url", "")
            group_name = sess.name or "未命名群组"

        items.append({
            "session_id": sess.id,
            "type": sess.type,
            "target_id": next((m.member_id for m in sess.members if m.member_id != user.id), None),
            "target_type": next((m.member_type for m in sess.members if m.member_id != user.id), None),
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
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    # Verify membership
    mem = await db.execute(
        select(ChatSessionMember).where(
            ChatSessionMember.session_id == session_id,
            ChatSessionMember.member_id == user.id,
        )
    )
    if not mem.scalar_one_or_none():
        raise HTTPException(status_code=403, detail="Not a member of this session")

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
        return user.nickname if msg.sender_id == user.id else "User"

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
            "is_me": m.sender_id == user.id and m.sender_type == "user",
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
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    mem = await db.execute(
        select(ChatSessionMember).where(
            ChatSessionMember.session_id == session_id,
            ChatSessionMember.member_id == user.id,
        )
    )
    if not mem.scalar_one_or_none():
        raise HTTPException(status_code=403, detail="Not a member")

    msg = ChatMessage(
        id=str(uuid.uuid4()),
        session_id=session_id,
        sender_id=user.id,
        sender_type="user",
        content=body.content,
        content_type=body.content_type,
        reply_to=body.reply_to,
    )
    db.add(msg)

    # Update session last_message_at
    sess = await db.execute(select(ChatSession).where(ChatSession.id == session_id))
    session = sess.scalar_one_or_none()
    if session:
        session.last_message_at = datetime.now(timezone.utc)

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
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(ChatSessionMember).where(
            ChatSessionMember.session_id == session_id,
            ChatSessionMember.member_id == user.id,
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
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(ChatSessionMember).where(
            ChatSessionMember.session_id == session_id,
            ChatSessionMember.member_id == user.id,
            ChatSessionMember.member_type == "user",
        )
    )
    member = result.scalar_one_or_none()
    if not member:
        raise HTTPException(status_code=403, detail="Not a member")
    member.last_read_at = datetime.now(timezone.utc)
    await db.commit()
    return Resp(data={"read": True})
