"""Agent-User intimacy relation model.

Design: intimacy score 0-1000, 5 levels, auto-decay.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import (
    Integer,
    String,
    DateTime,
    Index,
)
from sqlalchemy.orm import Mapped, mapped_column

from .base import Base, _utc_now


class AgentUserRelation(Base):
    __tablename__ = "agent_user_relations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    agent_id: Mapped[str] = mapped_column(String(36), nullable=False)
    user_id: Mapped[str] = mapped_column(String(36), nullable=False)

    # Intimacy score 0-1000
    score: Mapped[int] = mapped_column(Integer, default=0)
    level: Mapped[str] = mapped_column(String(16), default="stranger")

    # Stats
    total_messages: Mapped[int] = mapped_column(Integer, default=0)
    total_interactions: Mapped[int] = mapped_column(Integer, default=0)

    # Timestamps
    last_interaction_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime, nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=_utc_now, onupdate=_utc_now
    )

    __table_args__ = (
        Index("idx_intimacy_agent_user", "agent_id", "user_id", unique=True),
    )
