"""Context Pipeline: Hot Context scene-isolated + Zvec cross-scene semantic search + tiered downgrade.

Design reference: docs/design/context-pipeline-task.md
"""

from __future__ import annotations

import json
import logging
import math
import time
from typing import Any

from ..message.types import Message, MessageMeta
from ..agent.message_builder import MessageBuilder
from ..config.models import ContextConfig
from .token_counter import count_tokens

logger = logging.getLogger(__name__)


class ContextPipeline:
    """Assembles LLM prompt with retrieval, scoring, and tiered downgrade.

    - L1: Mind files + platform capabilities (highest priority, never downgraded)
    - L2: Group sender prefix (handled by MessageBuilder, never downgraded)
    - L3: Hot Context — recent messages from current scene
    - L4: Semantic retrieval results from Zvec (cross-scene)
    - L5: Topic summaries (warm/cold memory)
    - L6: Tool descriptions (highest priority, never downgraded)

    Downgrade order: L5 → L4 → L3.  L1/L2/L6 never touched.
    """

    def __init__(
        self,
        agent_id: str,
        msg_builder: MessageBuilder,
        embedder: Any,
        memory_store: Any,
        memory_system: Any,
        config: ContextConfig | None = None,
    ):
        self.agent_id = agent_id
        self.msg_builder = msg_builder
        self.embedder = embedder
        self.memory_store = memory_store
        self.memory_system = memory_system
        self.config = config or ContextConfig()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def assemble(
        self,
        history: list[Message],
        scene_info: str,
        mind_context: str,
        tools: list[dict],
        source_id: str,
        source_name: str = "",
        personality_desc: str = "",
        mention_desc: str = "",
        time_tag: str = "",
    ) -> list[Message]:
        """Assemble full prompt for LLM call.

        Args:
            history: Full in-memory conversation history (already scene-isolated).
            scene_info: Deprecated, kept for backward compat.
            mind_context: Mind files content (L1).
            tools: Tool schemas for token estimation (L6).
            source_id: Current scene identifier (used to label cross-scene memories).
            source_name: Human-readable scene name.
            personality_desc: Group-chat stay-silent instructions (L1.5).
            mention_desc: Group-chat @mention reminder (independent from personality).

        Returns:
            List of Message ready for LLM.
        """
        # Stage 1+2: retrieve + score semantic candidates (L4)
        semantic_candidates = await self._retrieve_semantic(history)

        # Stage 3: topic candidates (L5)
        topic_candidates = await self.memory_system.get_topic_candidates()

        # L3 Hot Context starts with full history; will be truncated if needed
        hot_context = list(history)

        # Downgrade loop
        while True:
            # Build L1+L3 via MessageBuilder (handles group sender prefix)
            base = self.msg_builder.build(hot_context, scene_info, mind_context, time_tag=time_tag)

            # Build L4 and L5 as system messages
            l4_msgs = self._build_l4(semantic_candidates, source_id)
            l5_msgs = self._build_l5(topic_candidates)

            # Insert L4/L5 + personality + mention before conversation history (after all existing system msgs)
            sys_count = sum(1 for m in base if m.role == "system")
            personality_msgs: list[Message] = []
            if personality_desc:
                personality_msgs.append(
                    Message(
                        role="system",
                        content=f"【群聊行为】\n{personality_desc}",
                        meta=MessageMeta(session_id=self.agent_id),
                    )
                )
            mention_msgs: list[Message] = []
            if mention_desc:
                mention_msgs.append(
                    Message(
                        role="system",
                        content=mention_desc,
                        meta=MessageMeta(session_id=self.agent_id),
                    )
                )
            messages = base[:sys_count] + personality_msgs + mention_msgs + l5_msgs + l4_msgs + base[sys_count:]

            # Estimate total tokens
            total_tokens = self._estimate_tokens(messages) + self._estimate_tools_tokens(tools)

            if total_tokens <= self.config.max_context_tokens:
                logger.debug(
                    "ContextPipeline assembled %d messages (~%d tokens) for agent %s",
                    len(messages),
                    total_tokens,
                    self.agent_id,
                )
                return messages

            # ---------- Downgrade ----------
            if topic_candidates and len(topic_candidates) > 1:
                topic_candidates = [self._merge_topics(topic_candidates)]
                logger.debug("ContextPipeline downgrade: merged L5 topics")
                continue

            if topic_candidates:
                topic_candidates = []
                logger.debug("ContextPipeline downgrade: dropped L5")
                continue

            if semantic_candidates and len(semantic_candidates) > 3:
                # Step down: 10→5→3→0
                if len(semantic_candidates) >= 10:
                    semantic_candidates = semantic_candidates[:5]
                elif len(semantic_candidates) >= 5:
                    semantic_candidates = semantic_candidates[:3]
                else:
                    semantic_candidates = []
                logger.debug("ContextPipeline downgrade: reduced L4 to %d", len(semantic_candidates))
                continue

            if semantic_candidates:
                semantic_candidates = []
                logger.debug("ContextPipeline downgrade: dropped L4")
                continue

            # Downgrade L3 (hot context)
            current_len = len(hot_context)
            if current_len > 20:
                hot_context = hot_context[-15:]
            elif current_len > 15:
                hot_context = hot_context[-10:]
            elif current_len > 10:
                hot_context = hot_context[-5:]
            else:
                logger.warning(
                    "ContextPipeline cannot fit within %d tokens even after max downgrade for agent %s",
                    self.config.max_context_tokens,
                    self.agent_id,
                )
                return messages
            logger.debug("ContextPipeline downgrade: reduced L3 to %d messages", len(hot_context))

    # ------------------------------------------------------------------
    # Stage 1+2: Retriever + Scorer
    # ------------------------------------------------------------------

    async def _retrieve_semantic(self, history: list[Message]) -> list[dict]:
        """Embed latest user message and search Zvec across ALL scenes.

        Returns scored & filtered candidates sorted by final_score desc.
        """
        if not self.embedder or not self.memory_store:
            return []

        # Use latest user message as query
        query_text = ""
        for msg in reversed(history):
            if msg.role == "user":
                query_text = MessageBuilder.extract_text_only(msg)
                break

        if not query_text:
            return []

        try:
            vec = await self.embedder.embed_single(query_text)
            if not vec:
                return []
            hits = self.memory_store.search(
                self.agent_id,
                vec,
                top_k=self.config.semantic_search_top_k,
            )
        except Exception as exc:
            logger.warning("ContextPipeline semantic retrieval failed: %s", exc)
            return []

        # Deduplicate against current history (avoid repeating messages already in L3)
        existing_ids = {m.meta.id for m in history if m.meta.id}
        hits = [h for h in hits if h.get("message_id") not in existing_ids]

        # Score with time decay
        now = time.time()
        scored: list[dict] = []
        for h in hits:
            base_score = h.get("score", 0.0)
            ts = h.get("timestamp", 0) or 0
            if ts > 0 and self.config.time_decay_half_life_hours > 0:
                hours_ago = max(0.0, now - ts) / 3600.0
                decay = math.exp(-hours_ago / self.config.time_decay_half_life_hours)
            else:
                decay = 1.0
            final_score = base_score * decay
            if final_score >= self.config.semantic_score_threshold:
                scored.append({**h, "final_score": final_score})

        scored.sort(key=lambda x: x["final_score"], reverse=True)
        return scored

    # ------------------------------------------------------------------
    # L4 / L5 builders
    # ------------------------------------------------------------------

    def _build_l4(self, candidates: list[dict], current_source_id: str) -> list[Message]:
        """Build semantic retrieval system message (L4)."""
        if not candidates:
            return []

        lines: list[str] = []
        for c in candidates:
            text = c.get("text", "")[:220]
            meta = c.get("metadata", {})
            src_name = meta.get("source_name", "") or meta.get("source", "") or "未知"
            src_id = meta.get("source_id", "")
            if src_id and src_id != current_source_id:
                lines.append(f"[来自 {src_name}] {text}")
            else:
                lines.append(text)

        content = "【相关历史记忆】\n" + "\n".join(f"- {line}" for line in lines)
        return [
            Message(
                role="system",
                content=content,
                meta=MessageMeta(session_id=self.agent_id),
            )
        ]

    def _build_l5(self, candidates: list[dict]) -> list[Message]:
        """Build topic summary system message (L5)."""
        if not candidates:
            return []

        lines: list[str] = []
        for c in candidates:
            summary = c.get("summary", "")[:300]
            src = c.get("source_name", "") or "未知"
            lines.append(f"[来自 {src}] {summary}")

        content = "【历史话题摘要】\n" + "\n".join(f"- {line}" for line in lines)
        return [
            Message(
                role="system",
                content=content,
                meta=MessageMeta(session_id=self.agent_id),
            )
        ]

    def _merge_topics(self, candidates: list[dict]) -> dict:
        """Merge multiple topic candidates into a single brief summary."""
        summaries = [c.get("summary", "") for c in candidates if c.get("summary")]
        merged = (
            f"共 {len(summaries)} 个历史话题: "
            + " | ".join(summaries[:3])
            + (" ..." if len(summaries) > 3 else "")
        )
        return {
            "id": "merged",
            "summary": merged[:500],
            "source_id": "",
            "source_name": "",
            "timestamp": 0,
            "score": 1.0,
        }

    # ------------------------------------------------------------------
    # Token estimation
    # ------------------------------------------------------------------

    def _estimate_tokens(self, messages: list[Message]) -> int:
        """Token estimation for downgrade decisions using tiktoken."""
        total = 0
        for msg in messages:
            content = msg.content
            if isinstance(content, str):
                total += count_tokens(content, self.agent_id)
            elif isinstance(content, list):
                for block in content:
                    if hasattr(block, "text"):
                        total += count_tokens(block.text, self.agent_id)
                    elif hasattr(block, "thinking"):
                        total += count_tokens(block.thinking, self.agent_id)
                    elif hasattr(block, "content"):
                        total += count_tokens(block.content, self.agent_id)
                    elif hasattr(block, "name") and hasattr(block, "input"):
                        total += count_tokens(
                            block.name + " " + str(block.input), self.agent_id
                        )
            else:
                total += count_tokens(str(content), self.agent_id)
        return max(1, total)

    def _estimate_tools_tokens(self, tools: list[dict]) -> int:
        """Token estimation for tool schemas."""
        if not tools:
            return 0
        try:
            json_str = json.dumps(tools, ensure_ascii=False)
            return count_tokens(json_str, self.agent_id)
        except Exception:
            return 2000
