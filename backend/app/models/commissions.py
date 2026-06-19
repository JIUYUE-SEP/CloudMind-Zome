"""Commission (auto-delegation) models."""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import (
    DateTime,
    ForeignKey,
    Index,
    Integer,
    JSON,
    String,
    Text,
)
from sqlalchemy.orm import Mapped, mapped_column

from .base import Base, _uuid, _utc_now


class Commission(Base):
    __tablename__ = "commissions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    agent_id: Mapped[str] = mapped_column(
        ForeignKey("agents.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(256), nullable=False)
    trigger_type: Mapped[str] = mapped_column(String(32), nullable=False)
    trigger_config: Mapped[Optional[dict]] = mapped_column(JSON, default=dict)
    action_type: Mapped[str] = mapped_column(String(32), nullable=False)
    action_config: Mapped[Optional[dict]] = mapped_column(JSON, default=dict)
    output_target: Mapped[str] = mapped_column(String(64), default="notification_center")
    status: Mapped[str] = mapped_column(String(16), default="active")
    next_run_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    last_run_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    last_run_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=_utc_now, onupdate=_utc_now
    )

    __table_args__ = (
        Index("idx_commissions_user_id", "user_id"),
        Index("idx_commissions_status", "status"),
        Index("idx_commissions_next_run", "status", "next_run_at"),
    )


class CommissionLog(Base):
    __tablename__ = "commission_logs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    commission_id: Mapped[str] = mapped_column(
        ForeignKey("commissions.id", ondelete="CASCADE"), nullable=False
    )
    status: Mapped[str] = mapped_column(String(16), default="success")
    result_summary: Mapped[str] = mapped_column(Text, default="")
    executed_at: Mapped[datetime] = mapped_column(DateTime, default=_utc_now)
    duration_ms: Mapped[int] = mapped_column(Integer, default=0)

    __table_args__ = (
        Index("idx_commission_logs_commission", "commission_id", "executed_at"),
    )
