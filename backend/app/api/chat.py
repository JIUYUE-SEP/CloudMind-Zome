"""Chat REST API: sessions, messages."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from ..dependencies import get_db, require_user, get_current_user
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
    stmt = (
        select(ChatSession)
        .join(ChatSessionMember, ChatSessionMember.session_id == ChatSession.id)
        .where(ChatSessionMember.member_id == user.id, ChatSessionMember.member_type == "user")
    )
    if type:
        stmt = stmt.where(ChatSession.type == type)

    stmt = stmt.order_by(ChatSession.last_message_at.desc().nullslast())
    stmt = stmt.options(selectinload(ChatSession.members), selectinload(ChatSession.messages))
    result = await db.execute(stmt)
    items = []
    for sess in result.scalars().all():
        # Find the "other" member for private chats
        other_name = ""
        other_avatar = ""
        if sess.type == "private":
            for m in sess.members:
                if m.member_id != user.id:
                    if m.member_type == "agent":
                        r = await db.execute(select(Agent).where(Agent.id == m.member_id))
                        a = r.scalar_one_or_none()
                        if a:
                            other_name = a.name
                            other_avatar = a.portrait_url or ""
                    break

        last_msg = None
        unread = 0
        if sess.messages:
            latest = max(sess.messages, key=lambda x: x.created_at or datetime.min.replace(tzinfo=timezone.utc))
            last_msg = {
                "content": latest.content[:100] if latest.content else "",
                "timestamp": latest.created_at.isoformat() if latest.created_at else "",
                "is_unread": latest.sender_id != user.id and not latest.is_deleted,
            }
            unread = sum(1 for m in sess.messages if m.sender_id != user.id and not m.is_deleted)

        # Group avatar from settings
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
            "unread_count": unread,
        })

    return Resp(data={"items": items})


@router.get("/sessions/{session_id}/messages", response_model=Resp)
async def get_messages(
    session_id: str,
    before_id: Optional[str] = Query(None),
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
            "timestamp": m.created_at.isoformat() if m.created_at else "",
            "is_me": m.sender_id == user.id and m.sender_type == "user",
            "batch_id": m.batch_id,
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
