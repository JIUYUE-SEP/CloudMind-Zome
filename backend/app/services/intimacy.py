"""Agent-User intimacy service: scoring, decay, level management.

Design reference: docs/design/interaction-architecture-v2.1.md
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone, timedelta
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import AsyncSessionLocal
from ..models import AgentUserRelation

logger = logging.getLogger(__name__)

# ------------------------------------------------------------------
# Score constants
# ------------------------------------------------------------------
_SCORE_MAP = {
    "private_user_msg": 2,
    "private_agent_reply": 3,
    "group_mention": 2,
    "group_spontaneous_user_reply": 4,
    "workflow_complete": 5,
    "user_share": 3,
    "agent_share_user_reply": 5,
}

_DECAY_MAP = [
    (timedelta(hours=24), -1),
    (timedelta(days=7), -5),
    (timedelta(days=30), None),  # reset to 0
]

_LEVELS = [
    (0, "stranger"),
    (51, "acquaintance"),
    (201, "friend"),
    (501, "close_friend"),
    (801, "soulmate"),
]

MAX_SCORE = 1000


# ------------------------------------------------------------------
# Public API
# ------------------------------------------------------------------

async def get_or_create(
    db: AsyncSession,
    agent_id: str,
    user_id: str,
) -> AgentUserRelation:
    result = await db.execute(
        select(AgentUserRelation).where(
            AgentUserRelation.agent_id == agent_id,
            AgentUserRelation.user_id == user_id,
        )
    )
    row = result.scalar_one_or_none()
    if row:
        return row
    row = AgentUserRelation(agent_id=agent_id, user_id=user_id)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


async def add_score(
    agent_id: str,
    user_id: str,
    event: str,
    db: AsyncSession | None = None,
) -> None:
    """Add intimacy score for an event.

    Args:
        event: one of the _SCORE_MAP keys.
    """
    delta = _SCORE_MAP.get(event, 0)
    if not delta:
        return

    if db is None:
        async with AsyncSessionLocal() as db:
            return await _apply_score(db, agent_id, user_id, delta)
    await _apply_score(db, agent_id, user_id, delta)


async def _apply_score(
    db: AsyncSession,
    agent_id: str,
    user_id: str,
    delta: int,
) -> None:
    rel = await get_or_create(db, agent_id, user_id)
    rel.score = min(MAX_SCORE, max(0, rel.score + delta))
    rel.total_interactions += 1
    rel.last_interaction_at = datetime.now(timezone.utc)
    rel.level = _score_to_level(rel.score)
    await db.commit()


def _score_to_level(score: int) -> str:
    level = "stranger"
    for threshold, name in _LEVELS:
        if score >= threshold:
            level = name
    return level


async def apply_decay(
    agent_id: str,
    user_id: str,
    db: AsyncSession | None = None,
) -> None:
    """Apply time-based decay. Called by scheduler or on load."""
    if db is None:
        async with AsyncSessionLocal() as db:
            return await _do_decay(db, agent_id, user_id)
    await _do_decay(db, agent_id, user_id)


async def _do_decay(
    db: AsyncSession,
    agent_id: str,
    user_id: str,
) -> None:
    rel = await db.execute(
        select(AgentUserRelation).where(
            AgentUserRelation.agent_id == agent_id,
            AgentUserRelation.user_id == user_id,
        )
    )
    row = rel.scalar_one_or_none()
    if not row or not row.last_interaction_at:
        return

    now = datetime.now(timezone.utc)
    elapsed = now - row.last_interaction_at.replace(tzinfo=timezone.utc)

    # 30d reset
    if elapsed >= timedelta(days=30):
        row.score = 0
        row.level = "stranger"
        await db.commit()
        logger.info("Intimacy reset for %s-%s (30d inactive)", agent_id, user_id)
        return

    # 7d -5
    if elapsed >= timedelta(days=7):
        new_score = max(0, row.score - 5)
        if new_score != row.score:
            row.score = new_score
            row.level = _score_to_level(new_score)
            await db.commit()
            logger.info("Intimacy -5 for %s-%s (7d)", agent_id, user_id)
        return

    # 24h -1
    if elapsed >= timedelta(hours=24):
        new_score = max(0, row.score - 1)
        if new_score != row.score:
            row.score = new_score
            row.level = _score_to_level(new_score)
            await db.commit()
            logger.info("Intimacy -1 for %s-%s (24h)", agent_id, user_id)


async def get_intimacy(
    agent_id: str,
    user_id: str,
) -> dict:
    """Return intimacy data for display."""
    async with AsyncSessionLocal() as db:
        rel = await get_or_create(db, agent_id, user_id)
        await apply_decay(agent_id, user_id, db)
        # re-fetch after decay
        result = await db.execute(
            select(AgentUserRelation).where(
                AgentUserRelation.agent_id == agent_id,
                AgentUserRelation.user_id == user_id,
            )
        )
        rel = result.scalar_one_or_none()
        if not rel:
            return {"score": 0, "level": "stranger", "total_messages": 0}
        return {
            "score": rel.score,
            "level": rel.level,
            "total_messages": rel.total_messages,
            "total_interactions": rel.total_interactions,
            "last_interaction_at": rel.last_interaction_at.isoformat() if rel.last_interaction_at else None,
        }


# Level display labels
_LEVEL_LABELS = {
    "stranger": "陌生人",
    "acquaintance": "熟人",
    "friend": "朋友",
    "close_friend": "挚友",
    "soulmate": "知己",
}

_LEVEL_UNLOCKS = {
    "stranger": [],
    "acquaintance": ["昵称称呼", "随意开场"],
    "friend": ["主动关心"],
    "close_friend": ["主动搜索分享", "情绪感应"],
    "soulmate": ["深度记忆", "主动预测需求"],
}


def level_label(level: str) -> str:
    return _LEVEL_LABELS.get(level, level)


def level_unlocks(level: str) -> list[str]:
    return _LEVEL_UNLOCKS.get(level, [])
