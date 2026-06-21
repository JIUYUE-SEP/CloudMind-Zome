"""Commission (auto-delegation) API + scheduler trigger."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..dependencies import get_db
from ..models import Agent, Commission, CommissionLog

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
    db: AsyncSession = Depends(get_db),
):
    stmt = select(Commission)
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
    db: AsyncSession = Depends(get_db),
):
    # Verify agent exists
    agent_row = await db.execute(
        select(Agent).where(Agent.id == body.agent_id, Agent.deleted_at.is_(None))
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
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Commission).where(Commission.id == commission_id)
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
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Commission).where(Commission.id == commission_id)
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
    db: AsyncSession = Depends(get_db),
):
    # Verify commission exists
    r = await db.execute(
        select(Commission).where(Commission.id == commission_id)
    )
    if not r.scalar_one_or_none():
        raise HTTPException(status_code=404)

    result = await db.execute(
        select(CommissionLog).where(CommissionLog.commission_id == commission_id)
        .order_by(CommissionLog.executed_at.desc())
    )
    items = []
    for log in result.scalars().all():
        items.append({
            "id": log.id,
            "status": log.status,
            "result_summary": log.result_summary,
            "executed_at": log.executed_at.isoformat() if log.executed_at else "",
            "duration_ms": log.duration_ms,
        })
    return Resp(data={"items": items})
