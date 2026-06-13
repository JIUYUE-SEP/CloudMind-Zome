"""Agent model."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Float,
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
    capabilities: Mapped[Optional[list]] = mapped_column(JSON, default=list)
    aliases: Mapped[Optional[list]] = mapped_column(JSON, default=list)  # ["vivi", "维维"]
    tags: Mapped[Optional[list]] = mapped_column(JSON, default=list)  # ["工作", "编程"]
    model_config: Mapped[Optional[dict]] = mapped_column(
        JSON, default=dict
    )  # {provider, model, temperature, max_tokens} — legacy, kept for compatibility
    allowed_paths: Mapped[Optional[list]] = mapped_column(
        JSON, default=list
    )  # Extra file-system paths this agent may access
    toolsets: Mapped[Optional[list]] = mapped_column(
        JSON, default=list
    )  # Enabled toolsets for this agent (e.g. ["file", "web"])
    enabled_skills: Mapped[Optional[list]] = mapped_column(
        JSON, default=list
    )  # Always-enabled skill names (e.g. ["news", "himalaya"])

    # --- Agent 级新增独立字段（从 model_config JSON 拆分）---
    provider_id: Mapped[Optional[str]] = mapped_column(
        ForeignKey("compute_providers.id", ondelete="SET NULL"), nullable=True
    )
    model_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    temperature: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    top_p: Mapped[Optional[float]] = mapped_column(Float, nullable=True)

    marker_provider_id: Mapped[Optional[str]] = mapped_column(
        ForeignKey("compute_providers.id", ondelete="SET NULL"), nullable=True
    )
    marker_model_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)

    embedder_provider_id: Mapped[Optional[str]] = mapped_column(
        ForeignKey("compute_providers.id", ondelete="SET NULL"), nullable=True
    )
    embedder_model_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)

    compressor_provider_id: Mapped[Optional[str]] = mapped_column(
        ForeignKey("compute_providers.id", ondelete="SET NULL"), nullable=True
    )
    compressor_model_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)

    imagegen_provider_id: Mapped[Optional[str]] = mapped_column(
        ForeignKey("compute_providers.id", ondelete="SET NULL"), nullable=True
    )
    imagegen_model_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)

    fallback_chain: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    personality: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    max_context_tokens: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
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
    # DEPRECATED: sandbox feature removed. Kept for SQLite compatibility (pre-3.35.0
    # does not support DROP COLUMN). No code reads or writes this field.
    sandbox_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    daily_tokens_used: Mapped[int] = mapped_column(Integer, default=0)
    is_observer: Mapped[bool] = mapped_column(Boolean, default=False)

    # --- Capability kill-switches (fail-degradation) ---
    semantic_search_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    image_generation_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    topic_compression_enabled: Mapped[bool] = mapped_column(Boolean, default=True)

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
