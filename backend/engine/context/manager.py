"""Context manager: memory injection, topic compression, token estimation.

Design reference: §6.4 上下文注入策略, §6.4.4-6.4.6
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

import shortuuid

from ..message.types import Message, MessageMeta
from ..config.models import ContextConfig

if TYPE_CHECKING:
    from ..provider.transport import ChatCompletionsTransport
    from ..session.store import SessionStore

logger = logging.getLogger(__name__)


class ContextManager:
    """Manages context injection, compression, and memory.

    Design reference: §6.4
    - Hot memory: recent messages from SQLite (deduplicated against current messages)
    - Warm memory: previous topic summaries for current session (relevance-filtered)
    - Cold memory: cross-session high-importance summaries (relevance-filtered)
    - Topic compression: triggered when tokens exceed threshold; summaries persisted
    """

    def __init__(
        self,
        config: ContextConfig | None = None,
        model: Any = None,
        session_store: SessionStore | None = None,
        context_window: int = 128000,
        embedder: Any = None,
        memory_store: Any = None,
    ):
        self.config = config or ContextConfig()
        self.model = model
        self.session_store = session_store
        self.context_window = context_window
        self.embedder = embedder
        self.memory_store = memory_store

    async def augment(
        self,
        messages: list[Message],
        session_id: str = "",
        layers: list[str] | None = None,
    ) -> list[Message]:
        """Inject memory into messages.

        Design reference: §6.4.2 注入逻辑, §6.4.3 记忆注入策略
        """
        if layers is None:
            layers = ["hot"]

        result = list(messages)

        # Semantic memory: vector similarity search for the current user task
        if "semantic" in layers and session_id:
            semantic_msgs = await self._get_semantic_memory(messages, session_id)
            if semantic_msgs:
                result = self._inject_semantic(result, semantic_msgs)

        # Hot memory: recent messages from SQLite, deduplicated by message id
        if "hot" in layers and session_id:
            existing_ids = {m.meta.id for m in messages if m.meta.id}
            hot_msgs = await self._get_hot_memory(session_id, exclude_ids=existing_ids)
            if hot_msgs:
                result = hot_msgs + result

        # Warm memory: relevance-filtered by light model
        if "warm" in layers and session_id:
            warm_summaries = await self._get_warm_summaries(session_id)
            relevant = await self._filter_relevant(result, warm_summaries)
            if relevant:
                result = self._inject_summaries(result, relevant, "Previous topics")

        # Cold memory: relevance-filtered by light model
        if "cold" in layers:
            cold_summaries = await self._get_cold_summaries(session_id)
            relevant = await self._filter_relevant(result, cold_summaries)
            if relevant:
                result = self._inject_summaries(result, relevant, "Cross-session memory")

        return result

    async def compress_if_needed(
        self,
        messages: list[Message],
        session_id: str = "",
    ) -> list[Message]:
        """Check if compression is needed and execute if so.

        Design reference: §6.4.4, §6.4.6
        """
        from .estimator import TokenEstimator

        estimator = TokenEstimator()
        token_count = estimator.estimate(messages)
        threshold = self.config.compact_threshold * self.context_window

        if token_count <= threshold:
            return messages

        logger.info(
            "Token count %d exceeds threshold %d, triggering compression",
            token_count,
            threshold,
        )
        compressed = await self._compress_topics(messages, session_id)

        new_token_count = estimator.estimate(compressed)
        if new_token_count > threshold:
            logger.warning(
                "Still over threshold after compression (%d tokens), aggressive compression",
                new_token_count,
            )
            compressed = await self._aggressive_compress(messages, session_id)

            final_count = estimator.estimate(compressed)
            if final_count > threshold:
                logger.error(
                    "Context overflow after aggressive compression (%d tokens). Aborting.",
                    final_count,
                )
                raise ContextOverflowError(
                    f"Context overflow: {final_count} tokens exceeds {threshold} threshold"
                )

        return compressed

    # ------------------------------------------------------------------
    # Memory accessors (backed by SQLite)
    # ------------------------------------------------------------------

    async def _get_semantic_memory(
        self, messages: list[Message], session_id: str
    ) -> list[dict]:
        """Search vector memory for messages semantically related to the current task."""
        if not self.embedder or not self.memory_store or not session_id:
            return []

        # Use the latest user message as query
        query_text = ""
        for msg in reversed(messages):
            if msg.role == "user":
                query_text = msg.get_text()
                break
        if not query_text:
            return []

        try:
            vec = await self.embedder.embed_single(query_text)
            if not vec:
                return []
            hits = self.memory_store.search(session_id, vec, top_k=3)
            return hits
        except Exception as exc:
            logger.warning("Semantic memory search failed: %s", exc)
            return []

    def _inject_semantic(
        self, messages: list[Message], hits: list[dict]
    ) -> list[Message]:
        """Inject semantic search results as a system message."""
        lines = ["[相关历史记忆]"]
        for h in hits:
            lines.append(f"- {h['text'][:200]}")
        msg = Message(
            role="system",
            content="\n".join(lines),
            meta=MessageMeta(session_id=messages[0].meta.session_id if messages else ""),
        )
        return [msg] + messages

    async def _get_hot_memory(
        self, session_id: str, exclude_ids: set[str] | None = None
    ) -> list[Message]:
        """Get hot memory: recent messages from SQLite, excluding already-present ids."""
        if not self.session_store or not session_id:
            return []

        try:
            msgs = await self.session_store.load_recent_messages(
                session_id, self.config.hot_memory_limit
            )
            if exclude_ids:
                msgs = [m for m in msgs if m.meta.id not in exclude_ids]
            return msgs
        except Exception as e:
            logger.warning("Failed to load hot memory: %s", e)
            return []

    async def _get_warm_summaries(self, session_id: str) -> list[dict]:
        """Get warm memory: topic summaries for current session."""
        if not self.session_store or not session_id:
            return []

        try:
            return await self.session_store.load_topics(session_id)
        except Exception as e:
            logger.warning("Failed to load warm memory: %s", e)
            return []

    async def _get_cold_summaries(self, session_id: str) -> list[dict]:
        """Get cold memory: cross-session high-importance topics."""
        if not self.session_store:
            return []

        try:
            return await self.session_store.load_cold_memories()
        except Exception as e:
            logger.warning("Failed to load cold memory: %s", e)
            return []

    async def _filter_relevant(
        self, messages: list[Message], summaries: list[dict]
    ) -> list[dict]:
        """Filter summaries by relevance to current task using light model."""
        if not summaries or not self.model:
            return summaries if summaries else []

        current_task = ""
        for msg in reversed(messages):
            if msg.role == "user":
                current_task = msg.get_text()
                break

        if not current_task:
            return summaries

        summary_text = "\n".join(
            f"[{i}] {s.get('name', 'topic')}: {s.get('summary', '')}"
            for i, s in enumerate(summaries)
        )
        prompt = f"""Given the current task: "{current_task}"

Available context summaries:
{summary_text}

Return ONLY the numbers (comma-separated) of summaries relevant to the current task.
If none are relevant, return "none".
"""
        try:
            from ..message.types import Message as MsgType
            response = await self.model.chat(
                messages=[
                    MsgType(role="system", content="You are a relevance filter."),
                    MsgType(role="user", content=prompt),
                ],
                tools=None,
            )
            result = response.content or "none"
            if result.lower().strip() == "none":
                return []
            indices = [int(x.strip()) for x in result.split(",") if x.strip().isdigit()]
            return [summaries[i] for i in indices if 0 <= i < len(summaries)]
        except Exception as e:
            logger.warning("Relevance filtering failed: %s", e)
            return summaries

    def _inject_summaries(
        self, messages: list[Message], summaries: list[dict], label: str
    ) -> list[Message]:
        """Inject summaries as a system message at the beginning."""
        summary_text = f"[{label}]\n" + "\n".join(
            f"- {s.get('name', 'topic')}: {s.get('summary', '')}"
            for s in summaries
        )
        summary_msg = Message(
            role="system",
            content=summary_text,
            meta=MessageMeta(session_id=messages[0].meta.session_id if messages else ""),
        )
        return [summary_msg] + messages

    async def _compress_topics(
        self, messages: list[Message], session_id: str
    ) -> list[Message]:
        """Compress inactive topics into summaries and persist to SQLite."""
        keep_recent = self.config.keep_recent
        if len(messages) <= keep_recent * 2:
            return messages

        to_compress = messages[: -(keep_recent * 2)]
        to_keep = messages[-(keep_recent * 2):]

        summary = ""
        if self.model and len(to_compress) > 0:
            conversation_text = "\n".join(
                f"{msg.role}: {msg.get_text()[:500]}"
                for msg in to_compress
                if msg.get_text()
            )
            prompt = f"""Summarize this conversation concisely, preserving key information:

{conversation_text}

Provide a 2-3 sentence summary of what was accomplished and what the user's goal is."""
            try:
                from ..message.types import Message as MsgType
                response = await self.model.chat(
                    messages=[MsgType(role="user", content=prompt)],
                    tools=None,
                )
                summary = response.content or ""
            except Exception as e:
                logger.warning("LLM compression failed: %s", e)
                summary = ""

        # Persist summary as a topic (warm memory)
        if summary and self.session_store and session_id:
            try:
                await self.session_store.save_topic(
                    topic_id=shortuuid.uuid(),
                    session_id=session_id,
                    name=f"round_{to_compress[0].meta.round}_{to_compress[-1].meta.round}",
                    summary=summary,
                    importance="medium",
                    original_message_ids=[
                        m.meta.id for m in to_compress if m.meta.id
                    ],
                    start_round=to_compress[0].meta.round if to_compress else 0,
                    end_round=to_compress[-1].meta.round if to_compress else 0,
                )
            except Exception as e:
                logger.warning("Failed to persist topic summary: %s", e)

        result = list(to_keep)
        if summary:
            notice = Message(
                role="system",
                content=f"[Earlier conversation summary: {summary}]",
                meta=MessageMeta(session_id=session_id, compressed=True),
            )
            result = [notice] + result
        else:
            notice = Message(
                role="system",
                content=f"[Context compressed. {len(to_compress)} earlier messages removed.]",
                meta=MessageMeta(session_id=session_id, compressed=True),
            )
            result = [notice] + result

        return result

    async def _aggressive_compress(
        self, messages: list[Message], session_id: str
    ) -> list[Message]:
        """Aggressive compression: keep only last 1 round + global summary."""
        result = messages[-2:] if len(messages) >= 2 else messages

        notice = Message(
            role="system",
            content="[Aggressive context compression. Full conversation has been summarized. Token budget critical.]",
            meta=MessageMeta(session_id=session_id, compressed=True),
        )
        return [notice] + result


class ContextOverflowError(Exception):
    """Raised when context cannot fit even after aggressive compression."""
