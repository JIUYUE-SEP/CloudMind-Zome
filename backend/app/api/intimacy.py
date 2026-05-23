"""Intimacy API: get score, level, unlocks."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from ..dependencies import require_user
from ..services.intimacy import get_intimacy, level_label, level_unlocks

router = APIRouter(prefix="/intimacy", tags=["intimacy"])


class Resp(BaseModel):
    code: int = 0
    data: dict = {}


@router.get("/{agent_id}", response_model=Resp)
async def get_intimacy_api(
    agent_id: str,
    user=Depends(require_user),
):
    data = await get_intimacy(agent_id, user.id)
    data["level_label"] = level_label(data["level"])
    data["unlocks"] = level_unlocks(data["level"])
    return Resp(data=data)
