"""Action (workflow) API: CRUD + run + logs."""

from __future__ import annotations

import uuid
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..dependencies import get_db
from ..models import Action, ActionRun, Agent
from ..services.workflow_engine import launch_workflow
from ..services.group_task_engine import GroupTaskEngine

router = APIRouter(prefix="/actions", tags=["actions"])


# ------------------------------------------------------------------
# Schemas
# ------------------------------------------------------------------
class ActionNode(BaseModel):
    id: str
    type: str = "agent"  # start | agent | tool | condition | approval | end
    x: float = 0
    y: float = 0
    agent_id: Optional[str] = None
    instruction: str = ""
    tool_name: Optional[str] = None
    timeout_seconds: int = 300
    requires_approval: bool = False
    is_critical: bool = False


class ActionEdge(BaseModel):
    source: str
    target: str
    label: Optional[str] = None  # for condition branches: "yes" | "no"


class ActionCreate(BaseModel):
    name: str
    description: str = ""
    nodes: List[ActionNode] = Field(default_factory=list)
    edges: List[ActionEdge] = Field(default_factory=list)


class ActionUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    nodes: Optional[List[ActionNode]] = None
    edges: Optional[List[ActionEdge]] = None
    status: Optional[str] = None


class SaveFromTaskBody(BaseModel):
    session_id: str
    name: Optional[str] = "群聊任务蓝图"


class Resp(BaseModel):
    code: int = 0
    data: dict


# ------------------------------------------------------------------
# Routes
# ------------------------------------------------------------------
@router.get("", response_model=Resp)
async def list_actions(
    status: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
):
    stmt = select(Action)
    if status:
        stmt = stmt.where(Action.status == status)
    if search:
        stmt = stmt.where(Action.name.ilike(f"%{search}%"))

    result = await db.execute(stmt.offset((page - 1) * page_size).limit(page_size))
    items = []
    for a in result.scalars().all():
        # Count runs
        runs = await db.execute(select(ActionRun).where(ActionRun.action_id == a.id))
        run_count = len(runs.scalars().all())
        items.append({
            "id": a.id,
            "name": a.name,
            "description": a.description,
            "status": a.status,
            "node_count": len(a.nodes or []),
            "run_count": run_count,
            "created_at": a.created_at.isoformat() if a.created_at else "",
            "updated_at": a.updated_at.isoformat() if a.updated_at else "",
        })

    return Resp(data={"items": items, "page": page, "page_size": page_size})


@router.get("/{action_id}", response_model=Resp)
async def get_action(
    action_id: str,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Action).where(Action.id == action_id))
    a = result.scalar_one_or_none()
    if not a:
        raise HTTPException(status_code=404)

    # Resolve agent names for nodes in a single batch query
    agent_ids = {n.get("agent_id") for n in (a.nodes or []) if n.get("agent_id")}
    from ..services.agent_resolver import get_agents_by_ids
    agents_by_id = get_agents_by_ids(list(agent_ids))

    enriched_nodes = []
    for n in (a.nodes or []):
        ag = agents_by_id.get(n.get("agent_id"))
        agent_name = ag.get("name") if ag else "Unknown"
        enriched_nodes.append({**n, "agent_name": agent_name})

    return Resp(data={
        "id": a.id,
        "name": a.name,
        "description": a.description,
        "nodes": enriched_nodes,
        "edges": a.edges or [],
        "status": a.status,
        "created_at": a.created_at.isoformat() if a.created_at else "",
        "updated_at": a.updated_at.isoformat() if a.updated_at else "",
    })


@router.post("", response_model=Resp)
async def create_action(
    body: ActionCreate,
    db: AsyncSession = Depends(get_db),
):
    action = Action(
        id=str(uuid.uuid4()),
        name=body.name,
        description=body.description,
        nodes=[n.model_dump() for n in body.nodes],
        edges=[e.model_dump() for e in body.edges],
        status="draft",
    )
    db.add(action)
    await db.commit()
    await db.refresh(action)
    return Resp(data={"id": action.id, "name": action.name})


@router.put("/{action_id}", response_model=Resp)
async def update_action(
    action_id: str,
    body: ActionUpdate,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Action).where(Action.id == action_id))
    action = result.scalar_one_or_none()
    if not action:
        raise HTTPException(status_code=404)

    if body.name is not None:
        action.name = body.name
    if body.description is not None:
        action.description = body.description
    if body.nodes is not None:
        action.nodes = [n.model_dump() for n in body.nodes]
    if body.edges is not None:
        action.edges = [e.model_dump() for e in body.edges]
    if body.status is not None:
        action.status = body.status

    await db.commit()
    return Resp(data={"updated": True})


@router.delete("/{action_id}", response_model=Resp)
async def delete_action(
    action_id: str,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Action).where(Action.id == action_id))
    action = result.scalar_one_or_none()
    if not action:
        raise HTTPException(status_code=404)

    # Check no running runs
    runs = await db.execute(
        select(ActionRun).where(ActionRun.action_id == action_id, ActionRun.status == "running").limit(1)
    )
    if runs.scalar_one_or_none():
        raise HTTPException(status_code=422, detail="Cannot delete action with running execution")

    await db.delete(action)
    await db.commit()
    return Resp(data={"deleted": True})


# ------------------------------------------------------------------
# Runs
# ------------------------------------------------------------------
@router.post("/{action_id}/run", response_model=Resp)
async def run_action(
    action_id: str,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Action).where(Action.id == action_id))
    action = result.scalar_one_or_none()
    if not action:
        raise HTTPException(status_code=404)

    run = ActionRun(
        id=str(uuid.uuid4()),
        action_id=action_id,
        status="pending",
        node_states=[],
    )
    db.add(run)
    await db.commit()
    await db.refresh(run)

    # Update action last_run_id
    action.last_run_id = run.id
    action.status = "active"
    await db.commit()

    # Trigger async execution
    await launch_workflow(run.id)

    return Resp(data={"run_id": run.id, "status": "pending"})


@router.get("/{action_id}/runs/{run_id}", response_model=Resp)
async def get_run(
    action_id: str,
    run_id: str,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(ActionRun).where(ActionRun.id == run_id, ActionRun.action_id == action_id)
    )
    run = result.scalar_one_or_none()
    if not run:
        raise HTTPException(status_code=404)

    return Resp(data={
        "run_id": run.id,
        "status": run.status,
        "node_states": run.node_states,
        "logs": run.logs[:100000] if run.logs else "",  # truncate
        "started_at": run.started_at.isoformat() if run.started_at else "",
        "ended_at": run.ended_at.isoformat() if run.ended_at else "",
    })


@router.post("/{action_id}/runs/{run_id}/stop", response_model=Resp)
async def stop_run(
    action_id: str,
    run_id: str,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(ActionRun).where(ActionRun.id == run_id, ActionRun.action_id == action_id)
    )
    run = result.scalar_one_or_none()
    if not run:
        raise HTTPException(status_code=404)

    if run.status == "running":
        # Signal the in-memory workflow engine to stop
        from ..services import workflow_engine as wf_mod
        wf_mod._stop_signals[run_id] = True

        run.status = "stopping"
        await db.commit()

    return Resp(data={"status": run.status})


# ------------------------------------------------------------------
# Save from group chat task
# ------------------------------------------------------------------
@router.post("/from-task", response_model=Resp)
async def save_from_task(
    body: SaveFromTaskBody,
    db: AsyncSession = Depends(get_db),
):
    """Save the last group-task blueprint to ActionCenter."""
    engine = GroupTaskEngine.get_active_engine(body.session_id)
    if not engine:
        raise HTTPException(status_code=404, detail="No active or recent task for this session")

    blueprint = engine.to_blueprint()
    action = Action(
        id=str(uuid.uuid4()),
        name=body.name or blueprint["name"],
        description=blueprint["description"],
        nodes=blueprint["nodes"],
        edges=blueprint["edges"],
        status="draft",
    )
    db.add(action)
    await db.commit()
    await db.refresh(action)
    return Resp(data={"id": action.id, "name": action.name})
