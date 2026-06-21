"""Background compression worker."""
from __future__ import annotations

import asyncio
import json
import logging
import time
from pathlib import Path
from typing import Optional

from .topic_context import TopicContext, TopicState, SubtopicState
from ...message.types import Message

logger = logging.getLogger(__name__)


class CompressionWorker:
    def __init__(
        self,
        agent_id: str,
        topic_context: TopicContext,
        messages: list[Message],
        model,
        embedder,
        memory_store,
        compressed_dir: Path,
        config: dict,
    ):
        self.agent_id = agent_id
        self.topic_context = topic_context
        self.messages = messages  # Reference to agent._messages
        self.model = model
        self.embedder = embedder
        self.memory_store = memory_store
        self.compressed_dir = compressed_dir
        self.config = config
        self.queue: asyncio.Queue = asyncio.Queue()
        self._running = False
        self._task: Optional[asyncio.Task] = None

    def start(self) -> None:
        if not self._running:
            self._running = True
            self._task = asyncio.create_task(self._run())

    def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()

    def enqueue(self, topic: TopicState, subtopic: SubtopicState) -> None:
        self.queue.put_nowait((topic, subtopic))

    async def _run(self) -> None:
        while self._running:
            try:
                topic, subtopic = await asyncio.wait_for(self.queue.get(), timeout=1.0)
                await self._compress(topic, subtopic)
            except asyncio.TimeoutError:
                continue
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error("Compression worker error: %s", e)

    async def _compress(self, topic: TopicState, subtopic: SubtopicState) -> None:
        # 1. Snapshot the current message list to avoid racing with the Agent loop.
        messages_snapshot = list(self.messages)
        keep_recent = self.config.get("keep_recent", 3)
        sub_msgs = [m for m in messages_snapshot if m.meta.id in subtopic.msg_ids]

        if len(sub_msgs) <= keep_recent:
            return

        to_compress = sub_msgs[: -(keep_recent)]
        to_keep_ids = {m.meta.id for m in sub_msgs[-(keep_recent) :]}

        # Determine primary source from messages
        source_counts: dict[tuple[str, str], int] = {}
        for m in to_compress:
            key = (getattr(m.meta, "source", "private"), getattr(m.meta, "source_id", ""))
            source_counts[key] = source_counts.get(key, 0) + 1
        primary_source, primary_source_id = (
            max(source_counts, key=source_counts.get)
            if source_counts
            else ("private", "")
        )

        # 2. Build conversation text
        conversation_text = "\n".join(
            f"{m.role}: {m.get_text()[:500]}"
            for m in to_compress
            if hasattr(m, "get_text") and m.get_text() is not None
        )

        # 3. LLM summarize
        summary_json = await self._llm_summarize(conversation_text)

        # 4. Write compressed file
        filename = f"{topic.id}_{subtopic.name}.md"
        filepath = self.compressed_dir / filename
        self._write_compressed_file(
            filepath, topic, subtopic, to_compress, summary_json,
            primary_source, primary_source_id,
        )

        # 5. Update topic context
        topic.compressed_files.append(str(filepath))
        subtopic.status = "compressed"
        # Remove compressed msg_ids
        subtopic.msg_ids = [mid for mid in subtopic.msg_ids if mid in to_keep_ids]

        # 6. Zvec indexing
        if self.embedder and self.memory_store:
            try:
                vec = await self.embedder.embed_single(
                    summary_json.get("summary", "")
                )
                if vec:
                    self.memory_store.add_topic(
                        agent_id=self.agent_id,
                        topic_id=topic.id,
                        subtopic=subtopic.name,
                        summary=summary_json.get("summary", ""),
                        importance=topic.retain,
                        embedding=vec,
                        source_id=primary_source_id,
                    )
            except Exception as e:
                logger.warning("Topic zvec indexing failed: %s", e)
                # Write .zvec_failed marker for retry on restart
                marker = filepath.with_suffix(".md.zvec_failed")
                marker.write_text(str(e), encoding="utf-8")

        # 7. Memory Bridge: append to MEMORY.md
        await self._memory_bridge(topic, subtopic, summary_json)

        # 8. Update message markers directly on the objects we compressed.
        # These are the same object references held by the Agent, so we can
        # mutate them without iterating the live message list.
        for m in to_compress:
            if m.meta.id:
                m.meta.compressed = True

        logger.info("Compressed topic %s/%s to %s", topic.id, subtopic.name, filepath)

    async def _llm_summarize(self, conversation_text: str) -> dict:
        prompt = f"""Summarize this conversation section into structured JSON:

{conversation_text}

Output JSON format:
{{
  "summary": "2-3 sentence summary",
  "key_decisions": ["decision 1", "decision 2"],
  "open_questions": ["question 1"],
  "user_sentiment": "focused/frustrated/curious/etc"
}}

Return ONLY valid JSON."""

        try:
            from ...message.types import Message as MsgType
            from ...provider.thinking.plain import PlainThinkingProfile
            from ...provider.transport import ChatCompletionsTransport

            # Use a lightweight transport for summarization
            transport = ChatCompletionsTransport(
                base_url=self.model.base_url,
                api_key=self.model.api_key,
                model=self.model.model,
                thinking_profile=PlainThinkingProfile(),
                timeout=60.0,
            )
            response = await transport.chat(
                messages=[MsgType(role="user", content=prompt)],
                tools=None,
            )
            text = response.content or "{}"
            return json.loads(text)
        except Exception as e:
            logger.warning("LLM summarization failed: %s", e)
            return {
                "summary": "[Summary generation failed]",
                "key_decisions": [],
                "open_questions": [],
                "user_sentiment": "unknown",
            }

    def _write_compressed_file(
        self,
        path: Path,
        topic: TopicState,
        subtopic: SubtopicState,
        messages: list[Message],
        summary: dict,
        source: str = "private",
        source_id: str = "",
    ) -> None:
        start_round = messages[0].meta.round if messages else 0
        end_round = messages[-1].meta.round if messages else 0
        msg_ids = [m.meta.id for m in messages if m.meta.id]

        content = f"""---
topic_id: "{topic.id}"
subtopic: "{subtopic.name}"
start_round: {start_round}
end_round: {end_round}
created_at: "{time.strftime('%Y-%m-%dT%H:%M:%S%z')}"
importance: "{topic.retain}"
source: "{source}"
source_id: "{source_id}"
message_ids: {json.dumps(msg_ids, ensure_ascii=False)}
---

## Summary
{summary.get("summary", "")}

## Key Decisions
{chr(10).join("- " + d for d in summary.get("key_decisions", []))}

## Open Questions
{chr(10).join("- " + q for q in summary.get("open_questions", []))}

## User Sentiment
{summary.get("user_sentiment", "unknown")}
"""
        path.write_text(content, encoding="utf-8")

    async def _memory_bridge(
        self, topic: TopicState, subtopic: SubtopicState, summary: dict
    ) -> None:
        """Append a brief record to MEMORY.md."""
        try:
            from app.database import WORKSPACE_ROOT
        except ImportError:
            WORKSPACE_ROOT = Path.home() / ".cloudmind-zome" / "workspace"

        memory_path = WORKSPACE_ROOT / self.agent_id / "MEMORY.md"
        if not memory_path.exists():
            return

        line = f"\n- [{time.strftime('%Y-%m-%d')}] [{topic.id}/{subtopic.name}] {summary.get('summary', '')[:100]}\n"
        with memory_path.open("a", encoding="utf-8") as f:
            f.write(line)
