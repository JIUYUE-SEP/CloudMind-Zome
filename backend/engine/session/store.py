"""Session persistence: per-agent SQLite + JSON Lines document storage.

Design reference: §6.11 会话持久化
Each agent has its own database under workspace/{agent_id}/agent.db.
Agent messages (cross-scene memory) are also persisted to human-readable
JSON Lines via AgentDataStore for physical isolation and transparency.
"""

from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import Any

import aiosqlite
import shortuuid

from engine.config.paths import get_workspace_root

from ..message.types import Message, ContentBlock, MessageMeta

logger = logging.getLogger(__name__)


def _get_agent_db_path(agent_id: str) -> Path:
    """Return the per-agent database path."""
    agent_dir = get_workspace_root() / agent_id
    agent_dir.mkdir(parents=True, exist_ok=True)
    return agent_dir / "agent.db"


class SessionStore:
    """SQLite-backed session store with FTS5 full-text search.

    Each agent has its own database file under workspace/{agent_id}/agent.db.
    """

    def __init__(self, agent_id: str, db_path: str | Path | None = None):
        self.agent_id = agent_id
        if db_path is None:
            db_path = _get_agent_db_path(agent_id)
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
        """Create tables and indexes.

        Four-phase execution to handle old-database migration safely:
        1. Create all tables (with latest schema)
        2. Migrate missing columns in old tables
        3. Create indexes (after columns are guaranteed to exist)
        4. Create FTS5 virtual tables and triggers (after columns exist)
        """
        async with self._lock:
            db = await self.connect()

            # Phase 1: Create all tables
            # llm_sessions and llm_messages are deprecated — replaced by
            # agent_messages + AgentDataStore JSON Lines.
            # We intentionally do NOT create them on new installs.
            # Existing tables are left untouched for migration safety.

            # llm_topics and llm_topics_fts are deprecated — replaced by
            # _compressed/*.md + zvec agent_topics collection.
            # We intentionally do NOT create them on new installs.
            # Existing tables are left untouched for migration safety.

            # Agent unified memory pool (this agent's own messages)
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

            # Phase 2: Migrate missing columns in old tables
            # Ensure all columns exist in agent_messages
            await self._ensure_agent_columns(db)

            # Phase 3: Create indexes (after columns are guaranteed to exist)
            await db.execute(
                "CREATE INDEX IF NOT EXISTS idx_agent_msgs_agent ON agent_messages(agent_id)"
            )
            await db.execute(
                "CREATE INDEX IF NOT EXISTS idx_agent_msgs_source ON agent_messages(source, agent_id)"
            )

            # Phase 4: Create FTS5 virtual tables and triggers
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

            await db.commit()
            logger.info("Session database initialized for agent %s: %s", self.agent_id, self.db_path)

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
        """DEPRECATED: Topic summaries now live in _compressed/*.md and zvec.

        Kept for backward compatibility with existing data.
        """
        logger.warning("SessionStore.save_topic() is deprecated")
        import time as time_mod

        db = await self.connect()
        # Ensure table exists for legacy data
        await db.execute(
            """
            CREATE TABLE IF NOT EXISTS llm_topics (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
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
        """DEPRECATED: Topic summaries now live in _compressed/*.md and zvec.

        Kept for backward compatibility with existing data.
        """
        logger.warning("SessionStore.load_topics() is deprecated")
        db = await self.connect()
        # Check if table exists (it won't on new installs)
        cursor = await db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='llm_topics'"
        )
        if not await cursor.fetchone():
            return []

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
        source: str = "private",
        source_id: str = "",
        source_name: str = "",
        sender_id: str = "",
        sender_name: str = "",
    ) -> None:
        """Save a message to this agent's memory pool (SQLite + JSON Lines)."""
        import shortuuid
        from ..message.types import ThinkingBlock, ToolUseBlock, ToolResultBlock, TextBlock
        from ..agent.data_store import AgentDataStore

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

        # Convert float timestamp to ISO string for compatibility
        ts_raw = message.meta.timestamp
        if ts_raw is None:
            import time
            ts_raw = time.time()
        if isinstance(ts_raw, (int, float)):
            from datetime import datetime, timezone
            ts_iso = datetime.fromtimestamp(ts_raw, tz=timezone.utc).isoformat()
        else:
            ts_iso = str(ts_raw)

        # Generate a single message UUID used by both JSONL and SQLite
        msg_uuid = message.meta.id or shortuuid.uuid()

        # Persist to AgentDataStore (human-readable JSON Lines)
        try:
            store = AgentDataStore(self.agent_id)
            store.ensure_dirs()
            memory_record = {
                "agent_id": self.agent_id,
                "role": message.role,
                "content": content or "",
                "tool_calls": tool_calls_json,
                "tool_name": tool_name,
                "tool_call_id": tool_call_id,
                "reasoning_content": reasoning_content,
                "timestamp": ts_iso,
                "token_count": message.meta.tokens_used,
                "round": message.meta.round,
                "compressed": message.meta.compressed,
                "message_uuid": msg_uuid,
                "source": source,
                "source_id": source_id,
                "source_name": source_name,
                "sender_id": sender_id or "",
                "sender_name": sender_name or "",
            }
            store.append_memory(memory_record)
        except Exception as exc:
            logger.warning("Failed to save agent message to document store: %s", exc)

        # Also persist to SQLite (backward compatibility + FTS5)
        db = await self.connect()
        await db.execute(
            """
            INSERT INTO agent_messages
            (agent_id, role, content, tool_calls, tool_name, reasoning_content,
             timestamp, token_count, round, compressed, message_uuid, tool_call_id,
             source, source_id, source_name, sender_id, sender_name)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                self.agent_id,
                message.role,
                content,
                tool_calls_json,
                tool_name,
                reasoning_content,
                ts_iso,
                message.meta.tokens_used,
                message.meta.round,
                message.meta.compressed,
                msg_uuid,
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
        source: str | None = None,
        source_id: str | None = None,
        limit: int = 1000,
    ) -> list[Message]:
        """Load messages from this agent's memory pool (JSON Lines + SQLite fallback)."""
        from ..message.types import ThinkingBlock, ToolUseBlock, ToolResultBlock, TextBlock
        from ..agent.data_store import AgentDataStore
        import time as time_mod

        # Try AgentDataStore first (human-readable JSON Lines)
        try:
            store = AgentDataStore(self.agent_id)
            memories = store.read_memories()
            # Filter by source/source_id if specified
            if source:
                memories = [m for m in memories if m.get("source") == source]
            if source_id:
                memories = [m for m in memories if m.get("source_id") == source_id]
            # Sort by timestamp and take limit
            memories.sort(key=lambda m: m.get("timestamp", ""), reverse=True)
            memories = memories[:limit]
            memories.reverse()

            if memories:
                messages = []
                for row in memories:
                    role = row.get("role", "")
                    content = row.get("content")
                    tool_calls = row.get("tool_calls")
                    reasoning_content = row.get("reasoning_content")
                    tool_call_id = row.get("tool_call_id")
                    timestamp = row.get("timestamp")
                    token_count = row.get("token_count")
                    round_num = row.get("round")
                    compressed = row.get("compressed", False)
                    message_uuid = row.get("message_uuid")
                    source_val = row.get("source", "private")
                    source_name = row.get("source_name", "")
                    sender_id = row.get("sender_id", "")
                    sender_name = row.get("sender_name", "")

                    # Normalize timestamp
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
                        session_id=source_id or "",
                        timestamp=ts_val,
                        tokens_used=token_count or 0,
                        round=round_num or 0,
                        compressed=bool(compressed),
                        source=source_val or "private",
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
                    elif tool_call_id:
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
        except Exception as exc:
            logger.warning("Failed to load agent messages from document store: %s", exc)

        # Fallback to SQLite
        db = await self.connect()

        conditions = ["agent_id = ?"]
        params: list[Any] = [self.agent_id]
        if source:
            conditions.append("source = ?")
            params.append(source)
        if source_id:
            conditions.append("source_id = ?")
            params.append(source_id)
        params.append(limit)

        where_clause = " AND ".join(conditions)

        async with db.execute(
            f"""
            SELECT role, content, tool_calls, reasoning_content, timestamp,
                   token_count, round, compressed, message_uuid, tool_call_id,
                   source, source_id, source_name, sender_id, sender_name
            FROM agent_messages
            WHERE {where_clause}
            ORDER BY id DESC
            LIMIT ?
            """,
            tuple(params),
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
            elif tool_call_id:
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

    async def load_agent_messages_by_uuids(
        self, uuids: list[str]
    ) -> list[Message]:
        """Load specific messages by their message_uuid values."""
        from ..message.types import ThinkingBlock, ToolUseBlock, ToolResultBlock, TextBlock
        import time as time_mod

        if not uuids:
            return []

        db = await self.connect()
        placeholders = ",".join("?" for _ in uuids)
        async with db.execute(
            f"""
            SELECT role, content, tool_calls, reasoning_content, timestamp,
                   token_count, round, compressed, message_uuid, tool_call_id,
                   source, source_id, source_name, sender_id, sender_name
            FROM agent_messages
            WHERE agent_id = ? AND message_uuid IN ({placeholders})
            ORDER BY id ASC
            """,
            [self.agent_id, *uuids],
        ) as cursor:
            rows = await cursor.fetchall()

        messages: list[Message] = []
        for row in rows:
            (
                role, content, tool_calls, reasoning_content, timestamp,
                token_count, round_num, compressed, message_uuid, tool_call_id,
                source, source_id, source_name, sender_id, sender_name,
            ) = row

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
            elif tool_call_id:
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

    async def get_agent_last_message_timestamp(
        self, offset: int = 0
    ) -> float | None:
        """Get timestamp of the N-th most recent message for this agent.

        offset=0 means the most recent message.
        Returns None if no message found at the given offset.
        """
        # Try AgentDataStore first
        try:
            from ..agent.data_store import AgentDataStore
            store = AgentDataStore(self.agent_id)
            memories = store.read_memories()
            if memories:
                # Sort by timestamp descending
                memories.sort(key=lambda m: m.get("timestamp", ""), reverse=True)
                if offset < len(memories):
                    ts_raw = memories[offset].get("timestamp")
                    if isinstance(ts_raw, str):
                        try:
                            from datetime import datetime
                            dt = datetime.fromisoformat(ts_raw.replace("Z", "+00:00"))
                            return dt.timestamp()
                        except Exception:
                            return None
                    return ts_raw
                return None
        except Exception as exc:
            logger.debug("Failed to get timestamp from document store: %s", exc)

        # Fallback to SQLite
        db = await self.connect()
        async with db.execute(
            """
            SELECT timestamp FROM agent_messages
            WHERE agent_id = ?
            ORDER BY id DESC
            LIMIT 1 OFFSET ?
            """,
            (self.agent_id, offset),
        ) as cursor:
            row = await cursor.fetchone()

        if not row:
            return None

        ts_raw = row[0]
        if isinstance(ts_raw, str):
            try:
                from datetime import datetime
                dt = datetime.fromisoformat(ts_raw.replace("Z", "+00:00"))
                return dt.timestamp()
            except Exception:
                return None
        return ts_raw

    async def delete_agent_messages_by_uuids(
        self, uuids: list[str]
    ) -> int:
        """Delete messages from agent_messages by their message_uuid values.

        Used after compression to remove the original messages that have been
        replaced by a summary. Returns the number of deleted rows.
        """
        if not uuids:
            return 0

        from ..agent.data_store import AgentDataStore

        store = AgentDataStore(self.agent_id)
        try:
            memories = store.read_memories()
            remaining = [m for m in memories if m.get("message_uuid") not in uuids]
            if len(remaining) < len(memories):
                store.write_memories(remaining)
        except Exception as exc:
            logger.error("Failed to delete messages from JSONL: %s", exc)
            raise

        db = await self.connect()
        placeholders = ",".join("?" for _ in uuids)
        cursor = await db.execute(
            f"DELETE FROM agent_messages WHERE agent_id = ? AND message_uuid IN ({placeholders})",
            [self.agent_id, *uuids],
        )
        await db.commit()
        return cursor.rowcount

    async def load_cold_memories(self, limit: int = 20) -> list[dict]:
        """DEPRECATED: Cold memory now handled by zvec semantic search.

        Kept for backward compatibility with existing data.
        """
        logger.warning("SessionStore.load_cold_memories() is deprecated")
        db = await self.connect()
        # Check if table exists (it won't on new installs)
        cursor = await db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='llm_topics'"
        )
        if not await cursor.fetchone():
            return []

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
