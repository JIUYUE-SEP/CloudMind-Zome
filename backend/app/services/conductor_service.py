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

from ..models import Agent, ChatMessage, ChatSession
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
        db: AsyncSession,
        bridge: EngineBridge,
    ):
        self.db = db
        self.bridge = bridge

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def handle_user_message(
        self,
        session: ChatSession,
        user_id: str,
        content: str,
    ) -> AsyncIterator[dict]:
        """Process a user message in a group with a conductor.

        Yields WS frames: chat.typing, chat.message (conductor Q&A).
        """
        _cleanup_qa_states()
        conductor_id = session.conductor_agent_id
        if not conductor_id:
            return

        key = _state_key(session.id, conductor_id)
        state = _qa_states.get(key)

        # Record user input in history (before any early returns)
        if state is not None and state.stage != "done":
            state.history.append({"role": "user", "content": content})
            if len(state.history) > 20:
                state.history = state.history[-10:]

        # Check if user wants to cancel
        if content.strip() in ("取消", "算了", "跳过", "cancel"):
            if state:
                state.stage = "done"
                yield self._msg_frame(session.id, conductor_id, "Q&A 已取消。", "system")
            return

        # Start new Q&A if none active and @队长
        if state is None or state.stage == "done":
            # Only start if message mentions conductor
            if "@队长" not in content and "@conductor" not in content.lower():
                return
            state = QAState(stage="questioning")
            state.history.append({"role": "user", "content": content})
            _qa_states[key] = state

        # Run conductor agent with Q&A context
        engine_session_id = f"group-qa:{session.id}:{conductor_id}"
        qa_prompt = self._build_qa_prompt(state, content)

        yield self._typing_frame(session.id, conductor_id, True)

        full_text = ""
        batch_id = str(uuid.uuid4())

        async for event in self.bridge.stream_chat(
            agent_id=conductor_id,
            session_id=engine_session_id,
            user_message=qa_prompt,
            source="group",
            source_name="群聊-队长Q&A",
            sender_name="队长",
        ):
            if event.get("type") == "content":
                text = event.get("data", {}).get("text", "")
                full_text += text
                yield self._msg_frame(session.id, conductor_id, text, "agent", batch_id=batch_id)

        yield self._typing_frame(session.id, conductor_id, False)

        # Save final conductor message
        if full_text:
            msg = ChatMessage(
                id=str(uuid.uuid4()),
                session_id=session.id,
                sender_id=conductor_id,
                sender_type="agent",
                content=full_text,
                batch_id=batch_id,
            )
            self.db.add(msg)
            await self.db.commit()

            # Update state
            state.history.append({"role": "conductor", "content": full_text})

            # Detect plan output (@序列)
            if "@序列" in full_text or "计划" in full_text:
                state.stage = "planning"
                state.plan = full_text
                # Append action buttons prompt (handled by frontend)
            elif state.stage == "questioning" and len(state.history) >= 4:
                # Auto-conclude after 4 rounds of Q&A
                state.stage = "planning"

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
        result = await self.db.execute(
            select(ChatSessionMember).where(
                ChatSessionMember.session_id == session.id,
                ChatSessionMember.member_type == "agent",
            )
        )
        candidates = []
        for m in result.scalars().all():
            if m.member_id == from_agent_id:
                continue
            agent = await self.db.execute(select(Agent).where(Agent.id == m.member_id))
            a = agent.scalar_one_or_none()
            if a:
                candidates.append(m.member_id)

        if not candidates:
            return

        next_agent_id = random.choice(candidates)

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
                yield self._msg_frame(session.id, next_agent_id, text, "agent", batch_id=batch_id)

        yield self._typing_frame(session.id, next_agent_id, False)

        if full_text:
            msg = ChatMessage(
                id=str(uuid.uuid4()),
                session_id=session.id,
                sender_id=next_agent_id,
                sender_type="agent",
                content=full_text,
                batch_id=batch_id,
            )
            self.db.add(msg)
            await self.db.commit()
            intermind_state.history.append({"role": "agent", "content": full_text})

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _build_qa_prompt(self, state: QAState, user_content: str) -> str:
        lines = [
            "你是这个群聊的队长（Conductor）。你的职责是：",
            "1. 通过追问澄清用户的任务需求",
            "2. 信息充分后，输出结构化的任务分解计划（@序列）",
            "3. 每次只问一个问题，保持简洁。",
            "",
            "历史对话：",
        ]
        for h in state.history[-6:]:
            role = "用户" if h["role"] == "user" else "队长"
            lines.append(f"{role}: {h['content']}")
        lines.append(f"用户: {user_content}")
        lines.append("")
        if state.stage == "questioning":
            lines.append("请提出下一个澄清问题，或如果信息已充分，直接输出 @序列 分解计划。")
        else:
            lines.append("请输出 @序列 任务分解计划。")
        return "\n".join(lines)

    def _msg_frame(
        self,
        session_id: str,
        sender_id: str,
        content: str,
        sender_type: str,
        batch_id: Optional[str] = None,
    ) -> dict:
        return {
            "type": "chat.message",
            "payload": {
                "session_id": session_id,
                "message": {
                    "id": str(uuid.uuid4()),
                    "sender_id": sender_id,
                    "sender_type": sender_type,
                    "sender_name": "队长" if sender_type == "agent" else "系统",
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
