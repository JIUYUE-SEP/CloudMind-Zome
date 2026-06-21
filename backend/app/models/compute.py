"""Compute provider and usage models."""

from __future__ import annotations

from datetime import datetime
from typing import Optional, List

from sqlalchemy import (
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    JSON,
    String,
    Text,
    UniqueConstraint,
    Boolean,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .base import Base, _uuid, _utc_now


class ComputeProvider(Base):
    __tablename__ = "compute_providers"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    provider_type: Mapped[str] = mapped_column(String(32), nullable=False)
    display_name: Mapped[str] = mapped_column(String(128), nullable=False)
    api_key_encrypted: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    config: Mapped[Optional[dict]] = mapped_column(JSON, default=dict)
    quota_total: Mapped[int] = mapped_column(Integer, default=0)
    quota_used: Mapped[int] = mapped_column(Integer, default=0)
    quota_remaining: Mapped[int] = mapped_column(Integer, default=0)
    expires_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="active")
    last_sync_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=_utc_now, onupdate=_utc_now
    )

    # --- Provider 级新增字段（网络/认证）---
    base_url: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    auth_mode: Mapped[str] = mapped_column(String(16), default="api_key")
    custom_headers: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    request_timeout: Mapped[float] = mapped_column(Float, default=120.0)
    max_retries: Mapped[int] = mapped_column(Integer, default=3)
    rate_limit_qpm: Mapped[int] = mapped_column(Integer, default=0)
    require_api_key: Mapped[bool] = mapped_column(Boolean, default=True)
    is_builtin: Mapped[bool] = mapped_column(Boolean, default=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # 关系：一对多 → LLMModel
    models: Mapped[List["LLMModel"]] = relationship(
        "LLMModel",
        back_populates="provider",
        cascade="all, delete-orphan",
        lazy="selectin",
    )


class ComputeUsage(Base):
    __tablename__ = "compute_usage"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    provider_id: Mapped[str] = mapped_column(
        ForeignKey("compute_providers.id", ondelete="CASCADE"), nullable=False
    )
    date: Mapped[str] = mapped_column(String(10), nullable=False)  # YYYY-MM-DD
    tokens_prompt: Mapped[int] = mapped_column(Integer, default=0)
    tokens_completion: Mapped[int] = mapped_column(Integer, default=0)
    tokens_total: Mapped[int] = mapped_column(Integer, default=0)
    requests_count: Mapped[int] = mapped_column(Integer, default=0)
    cost_estimated: Mapped[float] = mapped_column(Float, default=0.0)

    __table_args__ = (
        UniqueConstraint("provider_id", "date"),
        Index("idx_compute_usage_date", "provider_id", "date"),
    )
