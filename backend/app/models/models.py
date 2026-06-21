"""LLM Model definitions (independent Model table linked to Provider)."""

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
    Boolean,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .base import Base, _utc_now


class LLMModel(Base):
    """Independent LLM Model table, one-to-many with ComputeProvider.

    Primary key uses composite semantic key "provider_id::model_id"
    for stable internal references (e.g. FallbackChain).
    """

    __tablename__ = "llm_models"

    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    provider_id: Mapped[str] = mapped_column(
        ForeignKey("compute_providers.id", ondelete="CASCADE"),
        nullable=False,
    )

    display_name: Mapped[str] = mapped_column(String(128), nullable=False)
    is_builtin: Mapped[bool] = mapped_column(Boolean, default=False)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    status: Mapped[str] = mapped_column(String(16), default="active")

    # --- Model 级：物理属性 ---
    context_window: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    max_output_tokens: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    supports_multimodal: Mapped[bool] = mapped_column(Boolean, default=False)
    input_modalities: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    output_modalities: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    supports_streaming: Mapped[bool] = mapped_column(Boolean, default=True)
    supports_tool_calling: Mapped[bool] = mapped_column(Boolean, default=False)
    supports_reasoning: Mapped[bool] = mapped_column(Boolean, default=False)

    model_type: Mapped[str] = mapped_column(String(16), default="llm", nullable=False)
    pricing: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=_utc_now, onupdate=_utc_now
    )

    provider: Mapped["ComputeProvider"] = relationship(
        "ComputeProvider", back_populates="models"
    )

    __table_args__ = (
        Index("idx_llm_models_provider", "provider_id"),
    )
