"""Approval model."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import (
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
)
from sqlalchemy.orm import Mapped, mapped_column

from .base import Base, _uuid, _utc_now


class Approval(Base):
    __tablename__ = "approvals"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    agent_id: Mapped[str] = mapped_column(
        ForeignKey("agents.id", ondelete="CASCADE"), nullable=False
    )
    tool: Mapped[str] = mapped_column(String(128), nullable=False)
    command: Mapped[str] = mapped_column(Text, default="")
    source: Mapped[str] = mapped_column(String(32), default="workflow")
    source_id: Mapped[str] = mapped_column(String(36), default="")
    status: Mapped[str] = mapped_column(String(16), default="pending")
    timeout_seconds: Mapped[int] = mapped_column(Integer, default=60)
    requested_at: Mapped[datetime] = mapped_column(DateTime, default=_utc_now)
    expires_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    resolved_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    resolver_id: Mapped[Optional[str]] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    reason: Mapped[str] = mapped_column(Text, default="")

    __table_args__ = (
        Index("idx_approvals_status", "status", "requested_at"),
        Index("idx_approvals_agent", "agent_id", "status"),
    )
