"""Group chat API: create, info, conductor, settings."""

from __future__ import annotations

import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from ..database import UPLOAD_DIR
from ..dependencies import get_db, require_user
from ..models import Agent, ChatSession, ChatSessionMember, User

router = APIRouter(prefix="/chats/groups", tags=["groups"])


# ------------------------------------------------------------------
# Schemas
# ------------------------------------------------------------------
class CreateGroupReq(BaseModel):
    name: str
    member_ids: List[str]  # agent_ids


class UpdateGroupReq(BaseModel):
    name: Optional[str] = None
    announcement: Optional[str] = None
    avatar_url: Optional[str] = None
    settings: Optional[dict] = None


class SetConductorReq(BaseModel):
    agent_id: Optional[str] = None  # null = revoke


class InviteMembersReq(BaseModel):
    member_ids: List[str]  # agent_ids to invite


class Resp(BaseModel):
    code: int = 0
    data: dict


# ------------------------------------------------------------------
# Routes
# ------------------------------------------------------------------
@router.post("", response_model=Resp)
async def create_group(
    body: CreateGroupReq,
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    # Validate all members are user's agents
    result = await db.execute(
        select(Agent).where(
            Agent.id.in_(body.member_ids),
            Agent.user_id == user.id,
            Agent.deleted_at.is_(None),
        )
    )
    found = {a.id: a for a in result.scalars().all()}
    missing = [aid for aid in body.member_ids if aid not in found]
    if missing:
        raise HTTPException(status_code=400, detail=f"Invalid agent ids: {missing}")

    sess = ChatSession(
        id=str(uuid.uuid4()),
        type="group",
        name=body.name or "未命名群组",
        owner_id=user.id,
        settings={
            "intermind_enabled": False,
            "random_reply_count": 1,
            "routing_mode": "intent",
            "intermind_rounds": 4,
        },
    )
    db.add(sess)
    await db.flush()

    # Add owner
    db.add(ChatSessionMember(session_id=sess.id, member_id=user.id, member_type="user", role="owner"))
    # Add agents
    for aid in body.member_ids:
        db.add(ChatSessionMember(session_id=sess.id, member_id=aid, member_type="agent", role="member"))

    await db.commit()
    await db.refresh(sess)

    return Resp(data={
        "group_id": sess.id,
        "name": sess.name,
        "members": [{"id": aid, "name": found[aid].name} for aid in body.member_ids if aid in found],
    })


@router.get("/{group_id}", response_model=Resp)
async def get_group(
    group_id: str,
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(ChatSession).where(
            ChatSession.id == group_id,
            ChatSession.type == "group",
        ).options(selectinload(ChatSession.members))
    )
    sess = result.scalar_one_or_none()
    if not sess:
        raise HTTPException(status_code=404, detail="Group not found")

    # Verify membership
    mem = await db.execute(
        select(ChatSessionMember).where(
            ChatSessionMember.session_id == group_id,
            ChatSessionMember.member_id == user.id,
        )
    )
    if not mem.scalar_one_or_none():
        raise HTTPException(status_code=403, detail="Not a member")

    members = []
    for m in sess.members:
        name = ""
        avatar = ""
        is_conductor = sess.conductor_agent_id == m.member_id
        if m.member_type == "agent":
            r = await db.execute(select(Agent).where(Agent.id == m.member_id))
            a = r.scalar_one_or_none()
            if a:
                name = a.name
                avatar = a.portrait_url or ""
        else:
            name = user.nickname
            avatar = user.avatar_url or ""
        members.append({
            "member_id": m.member_id,
            "member_type": m.member_type,
            "name": name,
            "avatar": avatar,
            "role": m.role,
            "is_conductor": is_conductor,
        })

    return Resp(data={
        "group_id": sess.id,
        "name": sess.name,
        "owner_id": sess.owner_id,
        "announcement": sess.announcement,
        "avatar_url": (sess.settings or {}).get("avatar_url", ""),
        "settings": sess.settings,
        "conductor_agent_id": sess.conductor_agent_id,
        "members": members,
    })


@router.put("/{group_id}", response_model=Resp)
async def update_group(
    group_id: str,
    body: UpdateGroupReq,
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(ChatSession).where(ChatSession.id == group_id, ChatSession.type == "group")
    )
    sess = result.scalar_one_or_none()
    if not sess:
        raise HTTPException(status_code=404)

    # Only owner can update
    if sess.owner_id != user.id:
        raise HTTPException(status_code=403)

    if body.name is not None:
        sess.name = body.name
    if body.announcement is not None:
        sess.announcement = body.announcement
    if body.avatar_url is not None:
        sess.settings = {**(sess.settings or {}), "avatar_url": body.avatar_url}
    if body.settings is not None:
        sess.settings = {**(sess.settings or {}), **body.settings}

    await db.commit()
    return Resp(data={"updated": True})


@router.put("/{group_id}/conductor", response_model=Resp)
async def set_conductor(
    group_id: str,
    body: SetConductorReq,
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(ChatSession).where(ChatSession.id == group_id, ChatSession.type == "group")
    )
    sess = result.scalar_one_or_none()
    if not sess:
        raise HTTPException(status_code=404)
    if sess.owner_id != user.id:
        raise HTTPException(status_code=403)

    if body.agent_id:
        # Verify agent is member
        mem = await db.execute(
            select(ChatSessionMember).where(
                ChatSessionMember.session_id == group_id,
                ChatSessionMember.member_id == body.agent_id,
                ChatSessionMember.member_type == "agent",
            )
        )
        if not mem.scalar_one_or_none():
            raise HTTPException(status_code=400, detail="Agent is not a group member")

    sess.conductor_agent_id = body.agent_id
    await db.commit()

    agent_name = None
    if body.agent_id:
        r = await db.execute(select(Agent).where(Agent.id == body.agent_id))
        a = r.scalar_one_or_none()
        agent_name = a.name if a else None

    return Resp(data={
        "group_id": group_id,
        "conductor_agent_id": body.agent_id,
        "conductor_name": agent_name,
    })


@router.post("/{group_id}/members", response_model=Resp)
async def invite_members(
    group_id: str,
    body: InviteMembersReq,
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(ChatSession).where(ChatSession.id == group_id, ChatSession.type == "group")
    )
    sess = result.scalar_one_or_none()
    if not sess:
        raise HTTPException(status_code=404)
    if sess.owner_id != user.id:
        raise HTTPException(status_code=403, detail="Only owner can invite members")
    if sess.status == "dissolved":
        raise HTTPException(status_code=400, detail="Group is dissolved")

    # Validate agents exist
    agent_res = await db.execute(
        select(Agent).where(
            Agent.id.in_(body.member_ids),
            Agent.deleted_at.is_(None),
        )
    )
    valid_agents = {a.id: a for a in agent_res.scalars().all()}
    invalid = [mid for mid in body.member_ids if mid not in valid_agents]
    if invalid:
        raise HTTPException(status_code=400, detail=f"Invalid agent ids: {invalid}")

    # Check which are already members
    existing_res = await db.execute(
        select(ChatSessionMember.member_id).where(
            ChatSessionMember.session_id == group_id,
            ChatSessionMember.member_id.in_(body.member_ids),
        )
    )
    existing_ids = {r[0] for r in existing_res.all()}

    added = []
    for agent_id in body.member_ids:
        if agent_id not in existing_ids:
            db.add(ChatSessionMember(
                session_id=group_id,
                member_id=agent_id,
                member_type="agent",
                role="member",
            ))
            added.append({
                "id": agent_id,
                "name": valid_agents[agent_id].name,
            })

    await db.commit()

    return Resp(data={
        "added": added,
        "already_members": list(existing_ids),
    })


@router.delete("/{group_id}/members/{member_id}", response_model=Resp)
async def remove_member(
    group_id: str,
    member_id: str,
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(ChatSession).where(ChatSession.id == group_id, ChatSession.type == "group")
    )
    sess = result.scalar_one_or_none()
    if not sess:
        raise HTTPException(status_code=404)
    if sess.owner_id != user.id:
        raise HTTPException(status_code=403)

    # Can't remove self (owner)
    if member_id == user.id:
        raise HTTPException(status_code=400, detail="Cannot remove owner")

    mem = await db.execute(
        select(ChatSessionMember).where(
            ChatSessionMember.session_id == group_id,
            ChatSessionMember.member_id == member_id,
        )
    )
    row = mem.scalar_one_or_none()
    if row:
        await db.delete(row)
        # If removed agent was conductor, clear it
        if sess.conductor_agent_id == member_id:
            sess.conductor_agent_id = None
        await db.commit()

    return Resp(data={"removed": True})


@router.delete("/{group_id}", response_model=Resp)
async def dissolve_group(
    group_id: str,
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(ChatSession).where(ChatSession.id == group_id, ChatSession.type == "group")
    )
    sess = result.scalar_one_or_none()
    if not sess:
        raise HTTPException(status_code=404)
    if sess.owner_id != user.id:
        raise HTTPException(status_code=403)
    if sess.status == "dissolved":
        raise HTTPException(status_code=400, detail="Group already dissolved")

    sess.status = "dissolved"
    sess.name = f"{sess.name} (已解散)"
    await db.commit()
    return Resp(data={"dissolved": True})


# ------------------------------------------------------------------
# Upload
# ------------------------------------------------------------------
# UPLOAD_DIR is imported from app.database


def _save_upload(file: UploadFile, subfolder: str) -> str:
    ext = Path(file.filename or "file").suffix
    filename = f"{uuid.uuid4().hex}{ext}"
    folder = UPLOAD_DIR / subfolder
    folder.mkdir(parents=True, exist_ok=True)
    dest = folder / filename
    with dest.open("wb") as f:
        shutil.copyfileobj(file.file, f)
    return f"/uploads/{subfolder}/{filename}"


@router.post("/{group_id}/avatar", response_model=Resp)
async def upload_group_avatar(
    group_id: str,
    file: UploadFile = File(...),
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(ChatSession).where(ChatSession.id == group_id, ChatSession.type == "group")
    )
    sess = result.scalar_one_or_none()
    if not sess:
        raise HTTPException(status_code=404)
    if sess.owner_id != user.id:
        raise HTTPException(status_code=403)

    if file.content_type and not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Only image files allowed")

    url = _save_upload(file, "group_avatars")
    sess.settings = {**(sess.settings or {}), "avatar_url": url}
    await db.commit()

    return Resp(data={"avatar_url": url})
