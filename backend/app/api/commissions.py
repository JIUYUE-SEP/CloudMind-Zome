"""Commission (auto-delegation) API + scheduler trigger."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..dependencies import get_db, require_user
from ..models import Agent, Commission, CommissionLog, User

router = APIRouter(prefix="/commissions", tags=["commissions"])


# ------------------------------------------------------------------
# Schemas
# ------------------------------------------------------------------
class CommissionCreate(BaseModel):
    name: str
    agent_id: str
    trigger_type: str = "cron"  # cron / event / manual
    trigger_config: dict = {}
    action_type: str = "preset_chat"
    action_config: dict = {}
    output_target: str = "notification_center"


class CommissionUpdate(BaseModel):
    name: Optional[str] = None
    agent_id: Optional[str] = None
    trigger_type: Optional[str] = None
    trigger_config: Optional[dict] = None
    action_type: Optional[str] = None
    action_config: Optional[dict] = None
    output_target: Optional[str] = None
    status: Optional[str] = None  # active / paused / ended


class Resp(BaseModel):
    code: int = 0
    data: dict


# ------------------------------------------------------------------
# Routes
# ------------------------------------------------------------------
@router.get("", response_model=Resp)
async def list_commissions(
    status: Optional[str] = None,
    agent_id: Optional[str] = None,
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    stmt = select(Commission).where(Commission.user_id == user.id)
    if status:
        stmt = stmt.where(Commission.status == status)
    if agent_id:
        stmt = stmt.where(Commission.agent_id == agent_id)
    stmt = stmt.order_by(Commission.created_at.desc())

    result = await db.execute(stmt)
    items = []
    for c in result.scalars().all():
        items.append({
            "id": c.id,
            "name": c.name,
            "agent_id": c.agent_id,
            "trigger_type": c.trigger_type,
            "status": c.status,
            "next_run_at": c.next_run_at.isoformat() if c.next_run_at else None,
            "last_run_at": c.last_run_at.isoformat() if c.last_run_at else None,
            "created_at": c.created_at.isoformat() if c.created_at else "",
        })
    return Resp(data={"items": items})


@router.post("", response_model=Resp)
async def create_commission(
    body: CommissionCreate,
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    # Verify agent belongs to user
    agent_row = await db.execute(
        select(Agent).where(Agent.id == body.agent_id, Agent.user_id == user.id, Agent.deleted_at.is_(None))
    )
    if not agent_row.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Agent not found")

    # Compute initial next_run_at
    next_run = None
    if body.trigger_type == "interval":
        seconds = body.trigger_config.get("seconds", 3600)
        next_run = datetime.now(timezone.utc) + timedelta(seconds=seconds)
    elif body.trigger_type == "cron":
        expr = body.trigger_config.get("expression", "0 * * * *")
        try:
            from croniter import croniter
            next_run = croniter(expr, datetime.now(timezone.utc)).get_next(datetime)
        except Exception:
            next_run = datetime.now(timezone.utc) + timedelta(hours=1)

    comm = Commission(
        id=str(uuid.uuid4()),
        user_id=user.id,
        agent_id=body.agent_id,
        name=body.name,
        trigger_type=body.trigger_type,
        trigger_config=body.trigger_config,
        action_type=body.action_type,
        action_config=body.action_config,
        output_target=body.output_target,
        status="active",
        next_run_at=next_run,
    )
    db.add(comm)
    await db.commit()
    await db.refresh(comm)
    return Resp(data={"id": comm.id})


@router.put("/{commission_id}", response_model=Resp)
async def update_commission(
    commission_id: str,
    body: CommissionUpdate,
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Commission).where(Commission.id == commission_id, Commission.user_id == user.id)
    )
    comm = result.scalar_one_or_none()
    if not comm:
        raise HTTPException(status_code=404)

    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(comm, field, value)

    await db.commit()
    return Resp(data={"updated": True})


@router.delete("/{commission_id}", response_model=Resp)
async def delete_commission(
    commission_id: str,
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Commission).where(Commission.id == commission_id, Commission.user_id == user.id)
    )
    comm = result.scalar_one_or_none()
    if not comm:
        raise HTTPException(status_code=404)
    await db.delete(comm)
    await db.commit()
    return Resp(data={"deleted": True})


@router.get("/{commission_id}/logs", response_model=Resp)
async def get_logs(
    commission_id: str,
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    # Verify ownership
    r = await db.execute(
        select(Commission).where(Commission.id == commission_id, Commission.user_id == user.id)
    )
    if not r.scalar_one_or_none():
        raise HTTPException(status_code=403)

    result = await db.execute(
        select(CommissionLog).where(CommissionLog.commission_id == commission_id)
        .order_by(CommissionLog.executed_at.desc())
    )
    items = []
    for l in result.scalars().all():
        items.append({
            "id": l.id,
            "status": l.status,
            "result_summary": l.result_summary,
            "executed_at": l.executed_at.isoformat() if l.executed_at else "",
            "duration_ms": l.duration_ms,
        })
    return Resp(data={"items": items})
