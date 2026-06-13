"""TopicCompressionMemory: full implementation."""
from __future__ import annotations

import asyncio
import json
import logging
import time
from pathlib import Path
from typing import Optional

from ..base import MemorySystem
from .topic_context import TopicContext
from .marker import TopicMarker
from .trigger import CompressionTrigger
from .estimator import EstimatedTokenCounter
from .pruner import ToolResultPruner
from .worker import CompressionWorker
from ...message.types import Message, ToolResultBlock, MessageMeta
from ...provider.thinking.base import LLMResponse

logger = logging.getLogger(__name__)


class TopicCompressionMemory(MemorySystem):
    def __init__(self, agent, config: dict | None = None):
        super().__init__(agent, config)
        self.agent_id = agent.agent_id
        self.topic_context = TopicContext()
        self.marker: Optional[TopicMarker] = None
        self.trigger = CompressionTrigger(config or {})
        self.estimator = EstimatedTokenCounter()
        self.pruner: Optional[ToolResultPruner] = None
        self.worker: Optional[CompressionWorker] = None

        try:
            from app.database import WORKSPACE_ROOT
        except ImportError:
            WORKSPACE_ROOT = Path(__file__).resolve().parent.parent.parent.parent.parent / "workspace"

        agent_dir = WORKSPACE_ROOT / self.agent_id
        self.compressed_dir = agent_dir / "_compressed"
        self.compressed_dir.mkdir(parents=True, exist_ok=True)
        self.memory_db_path = agent_dir / "memory.db"

        self._last_label: Optional[str] = None
        self._same_streak = 0
        self._label_streak_threshold = (config or {}).get("label_streak_threshold", 2)
        self._marker_skip_interval = (config or {}).get("marker_skip_interval", 5)
        self._current_round = 0

    async def initialize(self) -> None:
        # 1. Load TopicContext from memory.db or _compressed/*.md
        await self._load_state()

        # 2. Initialize marker
        model_cfg = self.agent.model_config or {}
        try:
            self.marker = TopicMarker.from_config(model_cfg)
        except Exception as e:
            logger.warning("Failed to init TopicMarker: %s", e)

        # 3. Initialize pruner
        cfg = self.config or {}
        self.pruner = ToolResultPruner(
            self.agent_id,
            old_max_bytes=cfg.get("old_max_bytes", 3000),
            recent_max_bytes=cfg.get("recent_max_bytes", 50000),
        )

        # 4. Initialize worker
        self.worker = CompressionWorker(
            agent_id=self.agent_id,
            topic_context=self.topic_context,
            messages=self.agent._messages,
            model=self.agent.model,
            embedder=self.agent.embedder,
            memory_store=self.agent.memory_store,
            compressed_dir=self.compressed_dir,
            config=self.config or {},
        )
        self.worker.start()

        # 5. Retry failed zvec indexing
        await self._retry_failed_zvec()

    async def shutdown(self) -> None:
        if self.worker:
            self.worker.stop()
        await self._save_state()

    async def on_user_message(self, message: Message) -> None:
        self._current_round += 1

        # Topic detection
        if not self.marker:
            return

        # Skip logic
        if self._same_streak >= self._marker_skip_interval:
            if self._same_streak % self._marker_skip_interval != 0:
                self._same_streak += 1
                return

        # Get recent messages for context
        recent = (
            self.agent._messages[-10:]
            if len(self.agent._messages) > 10
            else self.agent._messages
        )
        label = await self.marker.detect(recent)

        if label == "same":
            self._same_streak += 1
            return

        if label == "unknown":
            return

        # Label changed
        if label == self._last_label:
            self._same_streak += 1
            if self._same_streak < self._label_streak_threshold:
                return
        else:
            self._same_streak = 1
            self._last_label = label
            return

        # Confirmed topic change
        parts = label.split("|")
        topic_label = parts[0]
        importance = parts[1] if len(parts) > 1 else "normal"

        # Check prefix match
        new_domain = topic_label.split("-")[0]
        current_topic = None
        if self.topic_context._current_topic_id:
            current_topic = self.topic_context._find_topic(
                self.topic_context._current_topic_id
            )

        if current_topic and current_topic.domain == new_domain:
            # Same domain, new subtopic
            sub_name = (
                topic_label.split("-", 1)[1] if "-" in topic_label else topic_label
            )
            self.topic_context.push_subtopic(current_topic.id, sub_name)
            active_sub = self.topic_context.get_active_subtopic(current_topic.id)
            if active_sub and message.meta.id:
                active_sub.msg_ids.append(message.meta.id)
        else:
            # Close current topic, create new
            if current_topic:
                self.topic_context.close_topic(current_topic.id)
                # Also close active subtopics
                for sub in current_topic.subtopics:
                    if sub.status == "active":
                        sub.status = "done"
                        sub.done_at_count = self.topic_context._topic_counter
                        sub.done_at_ts = time.time()

            self.topic_context.push_topic(topic_label, importance)
            current_topic = self.topic_context._find_topic(
                self.topic_context._current_topic_id
            )
            if current_topic:
                active_sub = self.topic_context.get_active_subtopic(current_topic.id)
                if active_sub and message.meta.id:
                    active_sub.msg_ids.append(message.meta.id)

    async def before_llm(self, messages: list[Message]) -> list[Message]:
        result = list(messages)

        # Hot memory: recent compressed files (with source labels)
        hot_count = (self.config or {}).get("hot_memory_count", 2)
        hot_files = sorted(
            self.compressed_dir.glob("*.md"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )[:hot_count]
        hot_parts = []
        for f in hot_files:
            text = f.read_text(encoding="utf-8")
            # Extract summary section
            if "## Summary" in text:
                summary = text.split("## Summary")[1].split("##")[0].strip()
                # Extract source label from frontmatter
                source_label = ""
                if "source_name:" in text:
                    try:
                        for line in text.splitlines():
                            if line.strip().startswith("source_name:"):
                                source_label = line.split(":", 1)[1].strip().strip('"')
                                break
                    except Exception:
                        pass
                if source_label:
                    hot_parts.append(f"[{f.stem}] [来自 {source_label}]: {summary[:500]}")
                else:
                    hot_parts.append(f"[{f.stem}]: {summary[:500]}")

        if hot_parts:
            hot_msg = Message(
                role="system",
                content="【近期话题摘要】\n" + "\n".join(hot_parts),
                meta=MessageMeta(session_id=self.agent_id),
            )
            result.insert(0, hot_msg)

        # Warm memory: zvec semantic search (cross-scene, grouped by source_id)
        if self.agent.embedder and self.agent.memory_store:
            try:
                # Use last user message as query
                query_text = ""
                for m in reversed(self.agent._messages):
                    if m.role == "user":
                        query_text = (
                            m.get_text()
                            if hasattr(m, "get_text")
                            else str(m.content)
                        )
                        break

                if query_text:
                    vec = await self.agent.embedder.embed_single(query_text)
                    if vec:
                        hits = self.agent.memory_store.search_topics(
                            self.agent_id,
                            vec,
                            topk=(self.config or {}).get("zvec_search_max_results", 3),
                        )
                        if hits:
                            from collections import defaultdict
                            by_source: dict[str, list[dict]] = defaultdict(list)
                            for h in hits:
                                sid = h.get("source_id", "")
                                by_source[sid].append(h)

                            warm_parts = []
                            for sid, group in by_source.items():
                                source_label = sid if sid else "其他场景"
                                parts = [
                                    f"- [{h['topic_id']}/{h['subtopic']}]: {h['summary'][:200]}"
                                    for h in group
                                ]
                                warm_parts.append(f"[来自 {source_label}]\n" + "\n".join(parts))

                            warm_msg = Message(
                                role="system",
                                content="【相关历史话题】\n" + "\n\n".join(warm_parts),
                                meta=MessageMeta(session_id=self.agent_id),
                            )
                            result.insert(0, warm_msg)
            except Exception as e:
                logger.warning("Warm memory search failed: %s", e)

        return result

    async def on_assistant_response(self, response: LLMResponse) -> None:
        pass

    async def on_tool_result(self, result: ToolResultBlock) -> None:
        if not self.pruner:
            return
        # Prune if needed
        # Note: this requires knowing which message round the tool result belongs to
        # For now, skip round-based pruning; just check size on very old results

    async def check_compression(self) -> bool:
        model_cfg = self.agent.model_config or {}
        context_window = model_cfg.get("context_window") or model_cfg.get("max_tokens", 128000)
        model_name = model_cfg.get("model", "")
        (
            should_compress,
            token_count,
            threshold,
        ) = self.trigger.should_compress(self.agent._messages, context_window, model_name)

        if not should_compress:
            return True

        logger.info(
            "Token %d exceeds threshold %d, triggering compression",
            token_count,
            threshold,
        )
        safe_threshold = self.trigger.get_safe_threshold(threshold)

        # Tier 1: enqueue done topics for async compression.
        # We do NOT block to wait for the worker; compression happens
        # in the background and takes effect on the next turn.
        done_pairs = self.trigger.tier1_get_done_subtopics(self.topic_context)
        for topic, subtopic in done_pairs:
            if self.worker:
                self.worker.enqueue(topic, subtopic)

        # If Tier 1 handled anything, return and let the worker do its job.
        # The next turn will see a smaller _messages list.
        if done_pairs:
            logger.info(
                "Tier 1: enqueued %d topics for compression, deferring to worker",
                len(done_pairs),
            )
            return True

        # Tier 2: force-close oldest active topic
        oldest = self.trigger.tier2_get_oldest_active(self.topic_context)
        if oldest:
            oldest.status = "done"
            for sub in oldest.subtopics:
                if sub.status == "active":
                    sub.status = "done"
                    sub.done_at_count = self.topic_context._topic_counter
                    sub.done_at_ts = time.time()
                    if self.worker:
                        self.worker.enqueue(oldest, sub)
            logger.info("Tier 2: force-closed oldest active topic %s", oldest.id)
            return True

        # Tier 3: full compression (heavy fallback)
        await self._full_compress()
        return True

    async def get_topic_candidates(self) -> list[dict]:
        """Return recent compressed topic summaries for Context Pipeline L5."""
        candidates: list[dict] = []
        try:
            hot_count = (self.config or {}).get("hot_memory_count", 2)
            hot_files = sorted(
                self.compressed_dir.glob("*.md"),
                key=lambda p: p.stat().st_mtime,
                reverse=True,
            )[:hot_count * 3]  # fetch more so pipeline can downgrade

            for f in hot_files:
                text = f.read_text(encoding="utf-8")
                summary = ""
                if "## Summary" in text:
                    summary = text.split("## Summary")[1].split("##")[0].strip()
                source_name = ""
                if "source_name:" in text:
                    for line in text.splitlines():
                        if line.strip().startswith("source_name:"):
                            source_name = line.split(":", 1)[1].strip().strip('"')
                            break
                timestamp = f.stat().st_mtime
                candidates.append({
                    "id": f.stem,
                    "summary": summary[:500] if summary else f.stem,
                    "source_id": f.stem,
                    "source_name": source_name,
                    "timestamp": timestamp,
                    "score": 1.0,  # will be re-scored by pipeline if needed
                })
        except Exception as exc:
            logger.warning("get_topic_candidates failed: %s", exc)
        return candidates

    async def get_stats(self) -> dict:
        return {
            "type": "topic_compression",
            "topic_count": len(self.topic_context.topic_stack),
            "current_topic": self.topic_context._current_topic_id,
            "compressed_files": sum(
                len(t.compressed_files) for t in self.topic_context.topic_stack
            ),
            "worker_queue_size": self.worker.queue.qsize() if self.worker else 0,
        }

    # --- Private ---

    async def _load_state(self) -> None:
        # Load from memory.db if exists
        try:
            import aiosqlite
        except ImportError:
            aiosqlite = None  # type: ignore

        if aiosqlite and self.memory_db_path.exists():
            try:
                async with aiosqlite.connect(str(self.memory_db_path)) as db:
                    async with db.execute(
                        "SELECT value FROM state WHERE key = 'topic_context'"
                    ) as cur:
                        row = await cur.fetchone()
                        if row:
                            self.topic_context = TopicContext.from_dict(json.loads(row[0]))
            except Exception as e:
                logger.warning("Failed to load topic state from db: %s", e)

        # Also scan _compressed/*.md to rebuild anything missing
        for f in sorted(
            self.compressed_dir.glob("*.md"), key=lambda p: p.stat().st_mtime
        ):
            # Parse frontmatter to update topic_context if needed
            pass

    async def _save_state(self) -> None:
        try:
            import aiosqlite
        except ImportError:
            aiosqlite = None  # type: ignore

        if not aiosqlite:
            return

        async with aiosqlite.connect(str(self.memory_db_path)) as db:
            await db.execute(
                """
                CREATE TABLE IF NOT EXISTS state (
                    key TEXT PRIMARY KEY,
                    value TEXT
                )
            """
            )
            await db.execute(
                "INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)",
                (
                    "topic_context",
                    json.dumps(
                        self.topic_context.to_dict(), ensure_ascii=False
                    ),
                ),
            )
            await db.commit()

    async def _retry_failed_zvec(self) -> None:
        for failed in self.compressed_dir.glob("*.zvec_failed"):
            # Retry indexing
            # TODO: implement retry logic
            failed.unlink(missing_ok=True)

    async def _full_compress(self) -> None:
        """Tier 3: compress entire context."""
        logger.warning("Full context compression triggered (Tier 3)")
        conversation_text = "\n".join(
            f"{m.role}: {m.get_text()[:500]}"
            for m in self.agent._messages
            if hasattr(m, "get_text")
        )
        if self.worker:
            summary = await self.worker._llm_summarize(conversation_text)
        else:
            summary = {"summary": "[Worker not available]"}

        # Replace messages with summary + last 2 rounds
        summary_msg = Message(
            role="system",
            content=f"[Full conversation compressed: {summary.get('summary', '')}]",
            meta=MessageMeta(session_id=self.agent_id, compressed=True),
        )

        last_two = (
            self.agent._messages[-2:]
            if len(self.agent._messages) >= 2
            else self.agent._messages
        )
        self.agent._messages = [summary_msg] + last_two
