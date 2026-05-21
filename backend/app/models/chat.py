"""Chat session and message models."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import List, Optional

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    JSON,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .base import Base, _uuid, _utc_now


class ChatSession(Base):
    __tablename__ = "chat_sessions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    type: Mapped[str] = mapped_column(String(16), nullable=False)  # private / group
    name: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    owner_id: Mapped[Optional[str]] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    conductor_agent_id: Mapped[Optional[str]] = mapped_column(
        ForeignKey("agents.id", ondelete="SET NULL"), nullable=True
    )
    announcement: Mapped[str] = mapped_column(Text, default="")
    settings: Mapped[Optional[dict]] = mapped_column(JSON, default=dict)
    last_message_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=_utc_now, onupdate=_utc_now
    )

    members: Mapped[List["ChatSessionMember"]] = relationship(
        back_populates="session", cascade="all, delete-orphan", lazy="selectin"
    )
    messages: Mapped[List["ChatMessage"]] = relationship(
        back_populates="session", cascade="all, delete-orphan", lazy="selectin"
    )

    __table_args__ = (
        Index("idx_chat_sessions_type", "type"),
        Index("idx_chat_sessions_last_msg", "last_message_at"),
    )


class ChatMessage(Base):
    __tablename__ = "chat_messages"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    session_id: Mapped[str] = mapped_column(
        ForeignKey("chat_sessions.id", ondelete="CASCADE"), nullable=False
    )
    sender_id: Mapped[str] = mapped_column(String(36), nullable=False)
    sender_type: Mapped[str] = mapped_column(String(16), nullable=False)  # user / agent / system
    content: Mapped[str] = mapped_column(Text, nullable=False)
    content_type: Mapped[str] = mapped_column(String(32), default="text")
    reply_to: Mapped[Optional[str]] = mapped_column(
        ForeignKey("chat_messages.id", ondelete="SET NULL"), nullable=True
    )
    batch_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utc_now)

    session: Mapped["ChatSession"] = relationship(back_populates="messages")

    __table_args__ = (
        Index("idx_chat_messages_session_id", "session_id"),
        Index("idx_chat_messages_created_at", "session_id", "created_at"),
        Index("idx_chat_messages_batch", "batch_id"),
    )


class ChatSessionMember(Base):
    __tablename__ = "chat_session_members"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    session_id: Mapped[str] = mapped_column(
        ForeignKey("chat_sessions.id", ondelete="CASCADE"), nullable=False
    )
    member_id: Mapped[str] = mapped_column(String(36), nullable=False)
    member_type: Mapped[str] = mapped_column(String(16), nullable=False)  # user / agent
    role: Mapped[str] = mapped_column(String(16), default="member")
    joined_at: Mapped[datetime] = mapped_column(DateTime, default=_utc_now)

    session: Mapped["ChatSession"] = relationship(back_populates="members")

    __table_args__ = (
        UniqueConstraint("session_id", "member_id"),
        Index("idx_chat_members_session", "session_id"),
    )
