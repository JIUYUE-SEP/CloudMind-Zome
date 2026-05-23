"""Agent model."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .base import Base, _uuid, _utc_now


class Agent(Base):
    __tablename__ = "agents"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    codename: Mapped[str] = mapped_column(String(64), nullable=False)
    personality_prompt: Mapped[str] = mapped_column(Text, default="")
    language_style: Mapped[str] = mapped_column(
        String(32), default="neutral"
    )  # formal / casual / artistic / technical / humorous
    opening_line: Mapped[str] = mapped_column(String(512), default="")
    memory_notes: Mapped[Optional[list]] = mapped_column(JSON, default=list)
    capabilities: Mapped[Optional[list]] = mapped_column(JSON, default=list)
    aliases: Mapped[Optional[list]] = mapped_column(JSON, default=list)  # ["vivi", "维维"]
    tags: Mapped[Optional[list]] = mapped_column(JSON, default=list)  # ["工作", "编程"]
    model_config: Mapped[Optional[dict]] = mapped_column(
        JSON, default=dict
    )  # {provider, model, temperature, max_tokens}
    represent_color: Mapped[str] = mapped_column(String(8), default="#00E5C9")
    portrait_url: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    model_url: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    live2d_model_url: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    action_set: Mapped[str] = mapped_column(String(64), default="default")
    status: Mapped[str] = mapped_column(String(16), default="idle")
    role: Mapped[str] = mapped_column(String(16), default="member")  # member / conductor
    conductor_of: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    priority_policy: Mapped[str] = mapped_column(String(32), default="fifo")
    daily_token_limit: Mapped[int] = mapped_column(Integer, default=100_000)
    timeout_seconds: Mapped[int] = mapped_column(Integer, default=300)
    fact_broadcast: Mapped[str] = mapped_column(String(16), default="private")
    sandbox_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    daily_tokens_used: Mapped[int] = mapped_column(Integer, default=0)
    is_observer: Mapped[bool] = mapped_column(Boolean, default=False)
    deleted_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=_utc_now, onupdate=_utc_now
    )

    user: Mapped["User"] = relationship(
        back_populates="agents",
        foreign_keys=[user_id],
    )

    __table_args__ = (
        Index("idx_agents_user_id", "user_id"),
        Index("idx_agents_status", "status"),
    )
