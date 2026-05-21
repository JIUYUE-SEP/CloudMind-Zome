"""Approval API: list, approve, reject, settings."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..dependencies import get_db, require_user
from ..models import Agent, Approval, User

router = APIRouter(prefix="/approvals", tags=["approvals"])


# ------------------------------------------------------------------
# Schemas
# ------------------------------------------------------------------
class ApprovalResp(BaseModel):
    code: int = 0
    data: dict


class ApproveReq(BaseModel):
    reason: Optional[str] = None


class RejectReq(BaseModel):
    reason: Optional[str] = None


class ApprovalSettings(BaseModel):
    default_timeout_seconds: int = 60
    timeout_policy: str = "reject"  # reject / approve / pause
    show_full_command: bool = True
    sound_alert: bool = True


# ------------------------------------------------------------------
# Routes
# ------------------------------------------------------------------
@router.get("", response_model=ApprovalResp)
async def list_approvals(
    status: Optional[str] = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    stmt = select(Approval).join(Agent, Approval.agent_id == Agent.id).where(Agent.user_id == user.id)
    if status:
        stmt = stmt.where(Approval.status == status)
    stmt = stmt.order_by(Approval.requested_at.desc())

    result = await db.execute(stmt.offset((page - 1) * page_size).limit(page_size))
    items = []
    for a in result.scalars().all():
        items.append({
            "approval_id": a.id,
            "agent_id": a.agent_id,
            "agent_name": "Agent",  # Could resolve
            "tool": a.tool,
            "command": a.command,
            "source": a.source,
            "source_id": a.source_id,
            "status": a.status,
            "timeout_seconds": a.timeout_seconds,
            "requested_at": a.requested_at.isoformat() if a.requested_at else "",
            "expires_at": a.expires_at.isoformat() if a.expires_at else "",
        })

    return ApprovalResp(data={"items": items, "page": page, "page_size": page_size})


@router.post("/{approval_id}/approve", response_model=ApprovalResp)
async def approve(
    approval_id: str,
    body: ApproveReq,
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Approval).where(Approval.id == approval_id))
    appr = result.scalar_one_or_none()
    if not appr:
        raise HTTPException(status_code=404)

    agent_res = await db.execute(select(Agent).where(Agent.id == appr.agent_id, Agent.user_id == user.id))
    if not agent_res.scalar_one_or_none():
        raise HTTPException(status_code=403, detail="Permission denied")

    appr.status = "approved"
    appr.resolved_at = datetime.now(timezone.utc)
    appr.resolver_id = user.id
    appr.reason = body.reason or ""
    await db.commit()

    return ApprovalResp(data={"approval_id": approval_id, "action": "approved"})


@router.post("/{approval_id}/reject", response_model=ApprovalResp)
async def reject(
    approval_id: str,
    body: RejectReq,
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Approval).where(Approval.id == approval_id))
    appr = result.scalar_one_or_none()
    if not appr:
        raise HTTPException(status_code=404)

    agent_res = await db.execute(select(Agent).where(Agent.id == appr.agent_id, Agent.user_id == user.id))
    if not agent_res.scalar_one_or_none():
        raise HTTPException(status_code=403, detail="Permission denied")

    appr.status = "rejected"
    appr.resolved_at = datetime.now(timezone.utc)
    appr.resolver_id = user.id
    appr.reason = body.reason or ""
    await db.commit()

    return ApprovalResp(data={"approval_id": approval_id, "action": "rejected"})


@router.get("/settings", response_model=ApprovalResp)
async def get_settings(user: User = Depends(require_user)):
    # For MVP, return hardcoded defaults; per-user settings can be added later
    return ApprovalResp(data={
        "default_timeout_seconds": 60,
        "timeout_policy": "reject",
        "show_full_command": True,
        "sound_alert": True,
    })
