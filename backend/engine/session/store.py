"""Session persistence: SQLite + FTS5 full-text search.

Design reference: §6.11 会话持久化
Tables use llm_ prefix to coexist with platform tables in cloudmind.db.
"""

from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import Any

import aiosqlite

from ..message.types import Message, ContentBlock, MessageMeta
from ..config.models import AppConfig

logger = logging.getLogger(__name__)


class SessionStore:
    """SQLite-backed session store with FTS5 full-text search.

    Design reference: §6.11.2 数据表设计
    Tables use llm_ prefix to coexist with platform tables in cloudmind.db.
    """

    def __init__(self, db_path: str | Path | None = None):
        if db_path is None:
            db_path = Path.home() / ".cloudmind-zome" / "cloudmind.db"
        self.db_path = Path(db_path).expanduser()
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._db: aiosqlite.Connection | None = None
        self._lock = asyncio.Lock()

    async def connect(self) -> aiosqlite.Connection:
        """Get or create database connection."""
        if self._db is None:
            self._db = await aiosqlite.connect(str(self.db_path))
            await self._create_tables()
        return self._db

    async def close(self) -> None:
        """Close database connection."""
        if self._db:
            await self._db.close()
            self._db = None

    async def _create_tables(self) -> None:
        """Create tables and indexes."""
        async with self._lock:
            db = await self.connect()

            # Sessions table (engine layer, renamed to avoid conflict with platform)
            await db.execute(
                """
                CREATE TABLE IF NOT EXISTS llm_sessions (
                    id TEXT PRIMARY KEY,
                    source TEXT NOT NULL DEFAULT 'api',
                    model TEXT NOT NULL,
                    provider TEXT NOT NULL,
                    system_prompt TEXT,
                    started_at REAL NOT NULL,
                    ended_at REAL,
                    end_reason TEXT,
                    message_count INTEGER DEFAULT 0,
                    tool_call_count INTEGER DEFAULT 0,
                    input_tokens INTEGER DEFAULT 0,
                    output_tokens INTEGER DEFAULT 0,
                    reasoning_tokens INTEGER DEFAULT 0,
                    estimated_cost_usd REAL DEFAULT 0,
                    parent_session_id TEXT REFERENCES llm_sessions(id)
                )
                """
            )

            # Messages table (engine layer)
            await db.execute(
                """
                CREATE TABLE IF NOT EXISTS llm_messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL REFERENCES llm_sessions(id),
                    role TEXT NOT NULL,
                    content TEXT,
                    tool_calls TEXT,
                    tool_call_id TEXT,
                    tool_name TEXT,
                    reasoning_content TEXT,
                    finish_reason TEXT,
                    timestamp REAL NOT NULL,
                    token_count INTEGER,
                    topic_id TEXT,
                    subtopic_name TEXT,
                    branch_id TEXT,
                    round INTEGER,
                    compressed BOOLEAN DEFAULT FALSE,
                    message_uuid TEXT
                )
                """
            )

            # Topics table (engine layer)
            await db.execute(
                """
                CREATE TABLE IF NOT EXISTS llm_topics (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL REFERENCES llm_sessions(id),
                    name TEXT NOT NULL,
                    subtopic_name TEXT,
                    importance TEXT NOT NULL,
                    summary TEXT NOT NULL,
                    original_message_ids TEXT,
                    start_round INTEGER,
                    end_round INTEGER,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                )
                """
            )

            # Indexes
            await db.execute(
                "CREATE INDEX IF NOT EXISTS idx_llm_messages_session ON llm_messages(session_id)"
            )
            await db.execute(
                "CREATE INDEX IF NOT EXISTS idx_llm_messages_topic ON llm_messages(topic_id)"
            )
            await db.execute(
                "CREATE INDEX IF NOT EXISTS idx_llm_topics_session ON llm_topics(session_id)"
            )

            # FTS5 virtual tables (engine layer)
            await db.execute(
                """
                CREATE VIRTUAL TABLE IF NOT EXISTS llm_messages_fts USING fts5(
                    content, tool_name, reasoning_content,
                    content=llm_messages, content_rowid=id
                )
                """
            )
            await db.execute(
                """
                CREATE VIRTUAL TABLE IF NOT EXISTS llm_topics_fts USING fts5(
                    name, summary,
                    content=llm_topics, content_rowid=id
                )
                """
            )

            # Ensure message_uuid column exists in old databases (llm_messages)
            await self._ensure_columns(db)

            # Agent unified memory pool (shared with platform layer)
            # Platform may have created this first with fewer columns.
            await db.execute(
                """
                CREATE TABLE IF NOT EXISTS agent_messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    agent_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    content TEXT,
                    tool_calls TEXT,
                    tool_call_id TEXT,
                    tool_name TEXT,
                    reasoning_content TEXT,
                    timestamp REAL NOT NULL,
                    token_count INTEGER,
                    round INTEGER,
                    compressed BOOLEAN DEFAULT FALSE,
                    message_uuid TEXT,
                    source TEXT NOT NULL DEFAULT 'private',
                    source_id TEXT,
                    source_name TEXT,
                    sender_id TEXT,
                    sender_name TEXT
                )
                """
            )
            await db.execute(
                "CREATE INDEX IF NOT EXISTS idx_agent_msgs_agent ON agent_messages(agent_id)"
            )
            await db.execute(
                "CREATE INDEX IF NOT EXISTS idx_agent_msgs_source ON agent_messages(source, agent_id)"
            )

            # FTS5 for agent_messages (cross-scene memory search)
            await db.execute(
                """
                CREATE VIRTUAL TABLE IF NOT EXISTS agent_messages_fts USING fts5(
                    content, tool_name, reasoning_content,
                    content=agent_messages, content_rowid=id
                )
                """
            )

            # FTS5 triggers for agent_messages (sync agent_messages_fts)
            await db.execute("""
                CREATE TRIGGER IF NOT EXISTS agent_msgs_fts_insert AFTER INSERT ON agent_messages
                BEGIN
                    INSERT INTO agent_messages_fts(rowid, content, tool_name, reasoning_content)
                    VALUES (new.id, new.content, new.tool_name, new.reasoning_content);
                END
            """)
            await db.execute("""
                CREATE TRIGGER IF NOT EXISTS agent_msgs_fts_delete AFTER DELETE ON agent_messages
                BEGIN
                    INSERT INTO agent_messages_fts(agent_messages_fts, rowid, content, tool_name, reasoning_content)
                    VALUES ('delete', old.id, old.content, old.tool_name, old.reasoning_content);
                END
            """)
            await db.execute("""
                CREATE TRIGGER IF NOT EXISTS agent_msgs_fts_update AFTER UPDATE ON agent_messages
                BEGIN
                    INSERT INTO agent_messages_fts(agent_messages_fts, rowid, content, tool_name, reasoning_content)
                    VALUES ('delete', old.id, old.content, old.tool_name, old.reasoning_content);
                    INSERT INTO agent_messages_fts(rowid, content, tool_name, reasoning_content)
                    VALUES (new.id, new.content, new.tool_name, new.reasoning_content);
                END
            """)

            # Ensure all columns exist (platform layer may have created table first)
            await self._ensure_agent_columns(db)

            await db.commit()
            logger.info("Session database initialized: %s", self.db_path)

    async def _ensure_columns(self, db: aiosqlite.Connection) -> None:
        """Add missing columns to existing tables."""
        cursor = await db.execute("PRAGMA table_info(llm_messages)")
        columns = {row[1] for row in await cursor.fetchall()}
        if "message_uuid" not in columns:
            await db.execute("ALTER TABLE llm_messages ADD COLUMN message_uuid TEXT")
            logger.info("Added message_uuid column to llm_messages table")

    async def _ensure_agent_columns(self, db: aiosqlite.Connection) -> None:
        """Add missing columns to agent_messages table with correct types."""
        cursor = await db.execute("PRAGMA table_info(agent_messages)")
        columns = {row[1] for row in await cursor.fetchall()}
        needed_text = [
            "tool_calls", "tool_call_id", "tool_name", "reasoning_content",
            "message_uuid", "source", "source_id", "source_name", "sender_id", "sender_name",
        ]
        needed_int = ["token_count", "round"]
        needed_bool = ["compressed"]
        for col in needed_text:
            if col not in columns:
                await db.execute(f"ALTER TABLE agent_messages ADD COLUMN {col} TEXT")
                logger.info("Added %s column to agent_messages table", col)
        for col in needed_int:
            if col not in columns:
                await db.execute(f"ALTER TABLE agent_messages ADD COLUMN {col} INTEGER")
                logger.info("Added %s column to agent_messages table", col)
        for col in needed_bool:
            if col not in columns:
                await db.execute(f"ALTER TABLE agent_messages ADD COLUMN {col} INTEGER DEFAULT 0")
                logger.info("Added %s column to agent_messages table", col)

    async def create_session(
        self,
        session_id: str,
        model: str,
        provider: str,
        system_prompt: str = "",
        parent_session_id: str | None = None,
    ) -> None:
        """Create a new session record."""
        import time as time_mod

        db = await self.connect()
        await db.execute(
            """
            INSERT OR IGNORE INTO llm_sessions (id, source, model, provider, system_prompt, started_at, parent_session_id)
            VALUES (?, 'api', ?, ?, ?, ?, ?)
            """,
            (
                session_id,
                model,
                provider,
                system_prompt,
                time_mod.time(),
                parent_session_id,
            ),
        )
        await db.commit()

    async def save_message(self, message: Message, session_id: str) -> None:
        """Save a message to the database.

        Preserves MessageMeta.id, ThinkingBlock content, and ToolResultBlock id.
        """
        import shortuuid
        from ..message.types import ThinkingBlock, ToolUseBlock, ToolResultBlock, TextBlock

        db = await self.connect()

        content: str | None = None
        tool_calls_json: str | None = None
        tool_name: str | None = None
        tool_call_id: str | None = None
        reasoning_content: str | None = None

        if isinstance(message.content, str):
            content = message.content
        else:
            text_parts: list[str] = []
            thinking_parts: list[str] = []
            tool_use_list: list[dict] = []

            for block in message.content:
                if isinstance(block, TextBlock):
                    text_parts.append(block.text)
                elif isinstance(block, ThinkingBlock):
                    thinking_parts.append(block.thinking)
                elif isinstance(block, ToolUseBlock):
                    tool_use_list.append(
                        {"id": block.id, "name": block.name, "input": block.input}
                    )
                elif isinstance(block, ToolResultBlock):
                    # Tool result: save content and tool_call_id
                    tool_call_id = block.id
                    content = block.content

            if text_parts and content is None:
                content = "\n".join(text_parts)
            if thinking_parts:
                reasoning_content = "\n".join(thinking_parts)
            if tool_use_list:
                tool_calls_json = json.dumps(tool_use_list)
                tool_name = tool_use_list[0]["name"]

        await db.execute(
            """
            INSERT INTO llm_messages
            (session_id, role, content, tool_calls, tool_name, reasoning_content,
             timestamp, token_count, topic_id, subtopic_name, branch_id, round, compressed,
             message_uuid, tool_call_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                session_id,
                message.role,
                content,
                tool_calls_json,
                tool_name,
                reasoning_content,
                message.meta.timestamp,
                message.meta.tokens_used,
                message.meta.topic_id,
                message.meta.subtopic_name,
                message.meta.branch_id,
                message.meta.round,
                message.meta.compressed,
                message.meta.id or shortuuid.uuid(),
                tool_call_id,
            ),
        )

        # Update session message count
        await db.execute(
            "UPDATE llm_sessions SET message_count = message_count + 1 WHERE id = ?",
            (session_id,),
        )

        await db.commit()

    async def load_messages(self, session_id: str, limit: int = 1000) -> list[Message]:
        """Load messages for a session."""
        from ..message.types import ThinkingBlock, ToolUseBlock, ToolResultBlock, TextBlock

        db = await self.connect()
        async with db.execute(
            """
            SELECT role, content, tool_calls, reasoning_content, timestamp,
                   token_count, topic_id, subtopic_name, branch_id, round, compressed,
                   message_uuid, tool_call_id
            FROM llm_messages
            WHERE session_id = ?
            ORDER BY id ASC
            LIMIT ?
            """,
            (session_id, limit),
        ) as cursor:
            rows = await cursor.fetchall()

        messages = []
        for row in rows:
            (
                role, content, tool_calls, reasoning_content, timestamp,
                token_count, topic_id, subtopic_name, branch_id, round_num, compressed,
                message_uuid, tool_call_id,
            ) = row

            meta = MessageMeta(
                id=message_uuid or shortuuid.uuid(),
                session_id=session_id,
                timestamp=timestamp,
                tokens_used=token_count or 0,
                topic_id=topic_id,
                subtopic_name=subtopic_name,
                branch_id=branch_id,
                round=round_num or 0,
                compressed=bool(compressed),
            )

            # Reconstruct content blocks
            content_blocks: list[ContentBlock] = []

            if reasoning_content:
                content_blocks.append(ThinkingBlock(thinking=reasoning_content))

            if tool_calls:
                tc_data = json.loads(tool_calls)
                for tc in tc_data:
                    content_blocks.append(
                        ToolUseBlock(
                            id=tc["id"], name=tc["name"], input=tc.get("input", {})
                        )
                    )
            elif tool_call_id is not None:
                # Tool result message
                content_blocks.append(
                    ToolResultBlock(
                        id=tool_call_id,
                        content=content or "",
                        truncated=False,
                    )
                )
            elif content:
                if content_blocks:
                    content_blocks.append(TextBlock(text=content))
                else:
                    content_blocks = content

            messages.append(Message(role=role, content=content_blocks, meta=meta))

        return messages

    async def update_session_stats(
        self,
        session_id: str,
        input_tokens: int | None = None,
        output_tokens: int | None = None,
        reasoning_tokens: int | None = None,
        estimated_cost: float | None = None,
        end_reason: str | None = None,
    ) -> None:
        """Update session statistics."""
        db = await self.connect()

        updates = []
        params = []

        if input_tokens is not None:
            updates.append("input_tokens = input_tokens + ?")
            params.append(input_tokens)
        if output_tokens is not None:
            updates.append("output_tokens = output_tokens + ?")
            params.append(output_tokens)
        if reasoning_tokens is not None:
            updates.append("reasoning_tokens = reasoning_tokens + ?")
            params.append(reasoning_tokens)
        if estimated_cost is not None:
            updates.append("estimated_cost_usd = estimated_cost_usd + ?")
            params.append(estimated_cost)
        if end_reason is not None:
            import time as time_mod

            updates.extend(["end_reason = ?", "ended_at = ?"])
            params.extend([end_reason, time_mod.time()])

        if updates:
            sql = f"UPDATE llm_sessions SET {', '.join(updates)} WHERE id = ?"
            params.append(session_id)
            await db.execute(sql, params)
            await db.commit()

    async def search_messages(self, query: str, session_id: str | None = None) -> list[dict]:
        """Search messages using FTS5."""
        db = await self.connect()

        if session_id:
            async with db.execute(
                """
                SELECT m.* FROM llm_messages m
                JOIN llm_messages_fts fts ON m.id = fts.rowid
                WHERE llm_messages_fts MATCH ? AND m.session_id = ?
                ORDER BY rank
                LIMIT 20
                """,
                (query, session_id),
            ) as cursor:
                rows = await cursor.fetchall()
        else:
            async with db.execute(
                """
                SELECT m.* FROM llm_messages m
                JOIN llm_messages_fts fts ON m.id = fts.rowid
                WHERE llm_messages_fts MATCH ?
                ORDER BY rank
                LIMIT 20
                """,
                (query,),
            ) as cursor:
                rows = await cursor.fetchall()

        return [dict(row) for row in rows]

    # ------------------------------------------------------------------
    # Recent messages (hot memory)
    # ------------------------------------------------------------------

    async def load_recent_messages(self, session_id: str, limit: int = 10) -> list[Message]:
        """Load most recent N messages for a session (newest first, reversed to ASC)."""
        from ..message.types import ThinkingBlock, ToolUseBlock, ToolResultBlock, TextBlock

        db = await self.connect()
        async with db.execute(
            """
            SELECT role, content, tool_calls, reasoning_content, timestamp,
                   token_count, topic_id, subtopic_name, branch_id, round, compressed,
                   message_uuid, tool_call_id
            FROM llm_messages
            WHERE session_id = ?
            ORDER BY id DESC
            LIMIT ?
            """,
            (session_id, limit),
        ) as cursor:
            rows = await cursor.fetchall()

        messages = []
        for row in reversed(rows):
            (
                role, content, tool_calls, reasoning_content, timestamp,
                token_count, topic_id, subtopic_name, branch_id, round_num, compressed,
                message_uuid, tool_call_id,
            ) = row

            meta = MessageMeta(
                id=message_uuid or shortuuid.uuid(),
                session_id=session_id,
                timestamp=timestamp,
                tokens_used=token_count or 0,
                topic_id=topic_id,
                subtopic_name=subtopic_name,
                branch_id=branch_id,
                round=round_num or 0,
                compressed=bool(compressed),
            )

            content_blocks: list[ContentBlock] = []
            if reasoning_content:
                content_blocks.append(ThinkingBlock(thinking=reasoning_content))
            if tool_calls:
                tc_data = json.loads(tool_calls)
                for tc in tc_data:
                    content_blocks.append(
                        ToolUseBlock(id=tc["id"], name=tc["name"], input=tc.get("input", {}))
                    )
            elif tool_call_id is not None:
                content_blocks.append(
                    ToolResultBlock(id=tool_call_id, content=content or "", truncated=False)
                )
            elif content:
                if content_blocks:
                    content_blocks.append(TextBlock(text=content))
                else:
                    content_blocks = content

            messages.append(Message(role=role, content=content_blocks, meta=meta))

        return messages

    # ------------------------------------------------------------------
    # Topic summaries (warm / cold memory)
    # ------------------------------------------------------------------

    async def save_topic(
        self,
        topic_id: str,
        session_id: str,
        name: str,
        summary: str,
        importance: str = "medium",
        subtopic_name: str | None = None,
        original_message_ids: list[str] | None = None,
        start_round: int = 0,
        end_round: int = 0,
    ) -> None:
        """Save or replace a topic summary."""
        import time as time_mod

        db = await self.connect()
        await db.execute(
            """
            INSERT OR REPLACE INTO llm_topics
            (id, session_id, name, subtopic_name, importance, summary,
             original_message_ids, start_round, end_round, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                topic_id,
                session_id,
                name,
                subtopic_name,
                importance,
                summary,
                json.dumps(original_message_ids or []),
                start_round,
                end_round,
                time_mod.time(),
                time_mod.time(),
            ),
        )
        await db.commit()

    async def load_topics(
        self, session_id: str, importance: str | None = None, limit: int = 20
    ) -> list[dict]:
        """Load topic summaries for a session."""
        db = await self.connect()
        if importance:
            async with db.execute(
                """
                SELECT id, name, subtopic_name, importance, summary,
                       original_message_ids, start_round, end_round, updated_at
                FROM llm_topics
                WHERE session_id = ? AND importance = ?
                ORDER BY updated_at DESC
                LIMIT ?
                """,
                (session_id, importance, limit),
            ) as cursor:
                rows = await cursor.fetchall()
        else:
            async with db.execute(
                """
                SELECT id, name, subtopic_name, importance, summary,
                       original_message_ids, start_round, end_round, updated_at
                FROM llm_topics
                WHERE session_id = ?
                ORDER BY updated_at DESC
                LIMIT ?
                """,
                (session_id, limit),
            ) as cursor:
                rows = await cursor.fetchall()

        return [
            {
                "id": row[0],
                "name": row[1],
                "subtopic_name": row[2],
                "importance": row[3],
                "summary": row[4],
                "original_message_ids": json.loads(row[5]) if row[5] else [],
                "start_round": row[6],
                "end_round": row[7],
                "updated_at": row[8],
            }
            for row in rows
        ]

    # ------------------------------------------------------------------
    # Agent unified memory pool
    # ------------------------------------------------------------------

    async def save_agent_message(
        self,
        message: Message,
        agent_id: str,
        source: str = "private",
        source_id: str = "",
        source_name: str = "",
        sender_id: str = "",
        sender_name: str = "",
    ) -> None:
        """Save a message to the unified agent memory pool."""
        import shortuuid
        import time as time_mod
        from ..message.types import ThinkingBlock, ToolUseBlock, ToolResultBlock, TextBlock

        db = await self.connect()

        content: str | None = None
        tool_calls_json: str | None = None
        tool_name: str | None = None
        tool_call_id: str | None = None
        reasoning_content: str | None = None

        if isinstance(message.content, str):
            content = message.content
        else:
            text_parts: list[str] = []
            thinking_parts: list[str] = []
            tool_use_list: list[dict] = []

            for block in message.content:
                if isinstance(block, TextBlock):
                    text_parts.append(block.text)
                elif isinstance(block, ThinkingBlock):
                    thinking_parts.append(block.thinking)
                elif isinstance(block, ToolUseBlock):
                    tool_use_list.append(
                        {"id": block.id, "name": block.name, "input": block.input}
                    )
                elif isinstance(block, ToolResultBlock):
                    tool_call_id = block.id
                    content = block.content

            if text_parts and content is None:
                content = "\n".join(text_parts)
            if thinking_parts:
                reasoning_content = "\n".join(thinking_parts)
            if tool_use_list:
                tool_calls_json = json.dumps(tool_use_list)
                tool_name = tool_use_list[0]["name"]

        # Convert float timestamp to ISO string for compatibility with platform DateTime
        ts_raw = message.meta.timestamp
        if ts_raw is None:
            import time
            ts_raw = time.time()
        if isinstance(ts_raw, (int, float)):
            from datetime import datetime, timezone
            ts_iso = datetime.fromtimestamp(ts_raw, tz=timezone.utc).isoformat()
        else:
            ts_iso = str(ts_raw)

        await db.execute(
            """
            INSERT INTO agent_messages
            (agent_id, role, content, tool_calls, tool_name, reasoning_content,
             timestamp, token_count, round, compressed, message_uuid, tool_call_id,
             source, source_id, source_name, sender_id, sender_name)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                agent_id,
                message.role,
                content,
                tool_calls_json,
                tool_name,
                reasoning_content,
                ts_iso,
                message.meta.tokens_used,
                message.meta.round,
                message.meta.compressed,
                message.meta.id or shortuuid.uuid(),
                tool_call_id,
                source,
                source_id,
                source_name,
                sender_id,
                sender_name,
            ),
        )
        await db.commit()

    async def load_agent_messages(
        self,
        agent_id: str,
        source: str | None = None,
        limit: int = 1000,
    ) -> list[Message]:
        """Load messages from the unified agent memory pool."""
        from ..message.types import ThinkingBlock, ToolUseBlock, ToolResultBlock, TextBlock
        import time as time_mod

        db = await self.connect()
        if source:
            async with db.execute(
                """
                SELECT role, content, tool_calls, reasoning_content, timestamp,
                       token_count, round, compressed, message_uuid, tool_call_id,
                       source, source_id, source_name, sender_id, sender_name
                FROM agent_messages
                WHERE agent_id = ? AND source = ?
                ORDER BY id DESC
                LIMIT ?
                """,
                (agent_id, source, limit),
            ) as cursor:
                rows = await cursor.fetchall()
        else:
            async with db.execute(
                """
                SELECT role, content, tool_calls, reasoning_content, timestamp,
                       token_count, round, compressed, message_uuid, tool_call_id,
                       source, source_id, source_name, sender_id, sender_name
                FROM agent_messages
                WHERE agent_id = ?
                ORDER BY id DESC
                LIMIT ?
                """,
                (agent_id, limit),
            ) as cursor:
                rows = await cursor.fetchall()

        messages = []
        for row in reversed(rows):
            (
                role, content, tool_calls, reasoning_content, timestamp,
                token_count, round_num, compressed, message_uuid, tool_call_id,
                source, source_id, source_name, sender_id, sender_name,
            ) = row

            # Normalize timestamp (ISO string or float)
            ts_val: float
            if isinstance(timestamp, str):
                try:
                    from datetime import datetime
                    dt = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
                    ts_val = dt.timestamp()
                except Exception:
                    ts_val = time_mod.time()
            else:
                ts_val = timestamp or time_mod.time()

            meta = MessageMeta(
                id=message_uuid or shortuuid.uuid(),
                session_id=source_id,
                timestamp=ts_val,
                tokens_used=token_count or 0,
                round=round_num or 0,
                compressed=bool(compressed),
                source=source or "private",
                source_name=source_name or "",
                sender_id=sender_id or "",
                sender_name=sender_name or "",
            )

            content_blocks: list[ContentBlock] = []
            if reasoning_content:
                content_blocks.append(ThinkingBlock(thinking=reasoning_content))
            if tool_calls:
                tc_data = json.loads(tool_calls)
                for tc in tc_data:
                    content_blocks.append(
                        ToolUseBlock(id=tc["id"], name=tc["name"], input=tc.get("input", {}))
                    )
            elif tool_call_id is not None:
                content_blocks.append(
                    ToolResultBlock(id=tool_call_id, content=content or "", truncated=False)
                )
            elif content:
                if content_blocks:
                    content_blocks.append(TextBlock(text=content))
                else:
                    content_blocks = content

            messages.append(Message(role=role, content=content_blocks, meta=meta))

        return messages

    async def delete_agent_messages_by_uuids(
        self, agent_id: str, uuids: list[str]
    ) -> int:
        """Delete messages from agent_messages by their message_uuid values.

        Used after compression to remove the original messages that have been
        replaced by a summary. Returns the number of deleted rows.
        """
        if not uuids:
            return 0
        db = await self.connect()
        placeholders = ",".join("?" for _ in uuids)
        cursor = await db.execute(
            f"DELETE FROM agent_messages WHERE agent_id = ? AND message_uuid IN ({placeholders})",
            [agent_id, *uuids],
        )
        await db.commit()
        return cursor.rowcount

    async def load_cold_memories(self, limit: int = 20) -> list[dict]:
        """Load cross-session high-importance topics as cold memory."""
        db = await self.connect()
        async with db.execute(
            """
            SELECT id, session_id, name, subtopic_name, importance, summary,
                   original_message_ids, start_round, end_round, updated_at
            FROM llm_topics
            WHERE importance = 'high'
            ORDER BY updated_at DESC
            LIMIT ?
            """,
            (limit,),
        ) as cursor:
            rows = await cursor.fetchall()

        return [
            {
                "id": row[0],
                "session_id": row[1],
                "name": row[2],
                "subtopic_name": row[3],
                "importance": row[4],
                "summary": row[5],
                "original_message_ids": json.loads(row[6]) if row[6] else [],
                "start_round": row[7],
                "end_round": row[8],
                "updated_at": row[9],
            }
            for row in rows
        ]
