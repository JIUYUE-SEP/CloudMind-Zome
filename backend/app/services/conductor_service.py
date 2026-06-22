"""Conductor (队长) Q&A state machine + intermind orchestration.

In-memory state per (session_id, conductor_agent_id).
"""

from __future__ import annotations

import logging
import random
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import AsyncIterator, Dict, List, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import AsyncSessionLocal
from ..models import Agent, ChatMessage, ChatSession, ChatSessionMember
from .engine_bridge import EngineBridge

logger = logging.getLogger(__name__)

# ------------------------------------------------------------------
# In-memory state
# ------------------------------------------------------------------
@dataclass
class QAState:
    stage: str = "questioning"  # questioning | planning | done
    history: List[dict] = field(default_factory=list)
    plan: Optional[str] = None
    started_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


_qa_states: Dict[str, QAState] = {}


def _state_key(session_id: str, conductor_id: str) -> str:
    return f"{session_id}:{conductor_id}"


def _cleanup_qa_states() -> None:
    now = datetime.now(timezone.utc)
    stale = [k for k, v in _qa_states.items() if (now - v.started_at).total_seconds() > 1800]
    for k in stale:
        del _qa_states[k]


# ------------------------------------------------------------------
# ConductorService
# ------------------------------------------------------------------
class ConductorService:
    """Handles @队长 Q&A and produces @序列 plans."""

    def __init__(
        self,
        db: AsyncSession | None = None,
        bridge: EngineBridge | None = None,
    ):
        # db is optional — if not provided, we create short-lived sessions internally
        self._external_db = db
        self.bridge = bridge

    # ------------------------------------------------------------------
    # Intermind
    # ------------------------------------------------------------------

    async def maybe_trigger_intermind(
        self,
        session: ChatSession,
        from_agent_id: str,
        agent_content: str,
    ) -> AsyncIterator[dict]:
        """After an agent replies, maybe trigger other agents to respond."""
        _cleanup_qa_states()
        settings = session.settings or {}
        if not settings.get("intermind_enabled", False):
            return

        # Count recent intermind rounds in this session (simple approximation)
        key = _state_key(session.id, "intermind")
        intermind_state = _qa_states.get(key)
        if intermind_state is None:
            intermind_state = QAState(stage="questioning", history=[])
            _qa_states[key] = intermind_state

        max_rounds = settings.get("intermind_rounds", 4)
        if len(intermind_state.history) >= max_rounds:
            yield self._msg_frame(
                session.id, "system", "—— 心智间对话结束 ——", "system"
            )
            intermind_state.stage = "done"
            return

        # Pick another idle agent (not the one who just spoke)
        async with AsyncSessionLocal() as db:
            result = await db.execute(
                select(ChatSessionMember).where(
                    ChatSessionMember.session_id == session.id,
                    ChatSessionMember.member_type == "agent",
                )
            )
            candidates = []
            from .agent_resolver import get_agent_name
            for m in result.scalars().all():
                if m.member_id == from_agent_id:
                    continue
                name = get_agent_name(m.member_id)
                if name:
                    candidates.append((m.member_id, name))

        if not candidates:
            return

        next_agent_id, next_agent_name = random.choice(candidates)

        # Build intermind prompt
        prompt = (
            f"[群聊上下文] 另一位心智刚刚说：{agent_content}\n"
            f"作为群聊成员，请简短回应（1-2句话），保持你的人格风格。"
        )

        engine_session_id = f"group-im:{session.id}:{next_agent_id}"
        yield self._typing_frame(session.id, next_agent_id, True)

        full_text = ""
        batch_id = str(uuid.uuid4())
        async for event in self.bridge.stream_chat(
            agent_id=next_agent_id,
            session_id=engine_session_id,
            user_message=prompt,
            source="group",
            source_name="群聊-心智间对话",
            sender_name="群聊成员",
        ):
            if event.get("type") == "content":
                text = event.get("data", {}).get("text", "")
                full_text += text
                yield self._msg_frame(session.id, next_agent_id, text, "agent", batch_id=batch_id, sender_name=next_agent_name)
            elif event.get("type") == "thinking":
                thinking_text = event.get("data", {}).get("thinking", "")
                if thinking_text:
                    yield {
                        "type": "chat.thinking",
                        "payload": {
                            "session_id": session.id,
                            "agent_id": next_agent_id,
                            "agent_name": next_agent_name,
                            "thinking": thinking_text,
                            "batch_id": batch_id,
                            "timestamp": datetime.now(timezone.utc).isoformat(),
                        }
                    }
            elif event.get("type") == "tool_call":
                tool_name = event.get("data", {}).get("name", "")
                tool_input = event.get("data", {}).get("input", {})
                if tool_name:
                    yield {
                        "type": "chat.tool_call",
                        "payload": {
                            "session_id": session.id,
                            "agent_id": next_agent_id,
                            "agent_name": next_agent_name,
                            "tool_name": tool_name,
                            "tool_input": tool_input,
                            "batch_id": batch_id,
                            "timestamp": datetime.now(timezone.utc).isoformat(),
                        }
                    }

        yield self._typing_frame(session.id, next_agent_id, False)

        if full_text:
            async with AsyncSessionLocal() as db:
                msg = ChatMessage(
                    id=str(uuid.uuid4()),
                    session_id=session.id,
                    sender_id=next_agent_id,
                    sender_type="agent",
                    content=full_text,
                    batch_id=batch_id,
                )
                db.add(msg)
                await db.commit()
            intermind_state.history.append({"role": "agent", "content": full_text})

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _msg_frame(
        self,
        session_id: str,
        sender_id: str,
        content: str,
        sender_type: str,
        batch_id: Optional[str] = None,
        sender_name: Optional[str] = None,
    ) -> dict:
        if sender_name is None:
            sender_name = "队长" if sender_type == "agent" else "系统"
        return {
            "type": "chat.message",
            "payload": {
                "session_id": session_id,
                "message": {
                    "id": str(uuid.uuid4()),
                    "sender_id": sender_id,
                    "sender_type": sender_type,
                    "sender_name": sender_name,
                    "content": content,
                    "content_type": "text",
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "is_me": False,
                    "batch_id": batch_id,
                }
            }
        }

    def _typing_frame(self, session_id: str, agent_id: str, is_typing: bool) -> dict:
        return {
            "type": "chat.typing",
            "payload": {
                "session_id": session_id,
                "user_id": agent_id,
                "is_typing": is_typing,
            }
        }


def _engine_state() -> dict:
    from ..main import _app_state
    return _app_state
