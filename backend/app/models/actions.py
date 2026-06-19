"""Action (workflow) models."""

from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from sqlalchemy import (
    DateTime,
    ForeignKey,
    Index,
    JSON,
    String,
    Text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .base import Base, _uuid, _utc_now


class Action(Base):
    __tablename__ = "actions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(256), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="")
    nodes: Mapped[Optional[list]] = mapped_column(JSON, default=list)
    edges: Mapped[Optional[list]] = mapped_column(JSON, default=list)
    status: Mapped[str] = mapped_column(String(16), default="draft")
    last_run_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=_utc_now, onupdate=_utc_now
    )

    runs: Mapped[List["ActionRun"]] = relationship(
        back_populates="action", cascade="all, delete-orphan"
    )

    __table_args__ = (
        Index("idx_actions_user_id", "user_id"),
        Index("idx_actions_status", "status"),
    )


class ActionRun(Base):
    __tablename__ = "action_runs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    action_id: Mapped[str] = mapped_column(
        ForeignKey("actions.id", ondelete="CASCADE"), nullable=False
    )
    status: Mapped[str] = mapped_column(
        String(16), default="pending"
    )
    node_states: Mapped[Optional[list]] = mapped_column(JSON, default=list)
    logs: Mapped[str] = mapped_column(Text, default="")
    started_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    ended_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utc_now)

    action: Mapped["Action"] = relationship(back_populates="runs")

    __table_args__ = (
        Index("idx_action_runs_action_id", "action_id"),
        Index("idx_action_runs_status", "status"),
    )
