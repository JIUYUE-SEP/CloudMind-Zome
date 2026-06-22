"""AgentDataStore: per-agent document-based data store.

Migrates agent data from shared SQLite to human-readable documents
in workspace/{agent_id}/.
"""

from __future__ import annotations

import json
import logging
import shutil
from pathlib import Path
from typing import Any, Callable

logger = logging.getLogger(__name__)


class AgentDataStore:
    """Document-based data store for a single agent.

    All data is stored as human-readable files under workspace/{agent_id}/:
      - config.json              : Agent configuration (single JSON)
      - data/sessions.jsonl      : Chat session metadata (JSON Lines)
      - data/messages/{session_id}.jsonl : Messages per session (JSON Lines)
      - data/llm_sessions.jsonl  : LLM session records (JSON Lines)
      - data/llm_messages.jsonl  : LLM messages (JSON Lines)
      - data/memories.jsonl      : Cross-scene memory pool (JSON Lines)
    """

    def __init__(self, agent_id: str, workspace_root: Path | str | None = None):
        self.agent_id = agent_id
        if workspace_root is None:
            try:
                from app.database import WORKSPACE_ROOT
            except ImportError:
                WORKSPACE_ROOT = Path.home() / ".cloudmind-zome" / "workspace"
            workspace_root = WORKSPACE_ROOT
        self.workspace_root = Path(workspace_root)
        self.agent_dir = self.workspace_root / agent_id

    # ------------------------------------------------------------------
    # Directory helpers
    # ------------------------------------------------------------------

    def ensure_dirs(self) -> None:
        """Create all necessary directories for this agent."""
        self.agent_dir.mkdir(parents=True, exist_ok=True)
        (self.agent_dir / "data" / "messages").mkdir(parents=True, exist_ok=True)

    def _data_path(self, name: str) -> Path:
        return self.agent_dir / "data" / name

    def _message_path(self, session_id: str) -> Path:
        return self.agent_dir / "data" / "messages" / f"{session_id}.jsonl"

    # ------------------------------------------------------------------
    # Config (single JSON file)
    # ------------------------------------------------------------------

    def read_config(self) -> dict[str, Any] | None:
        """Read agent configuration from config.json.

        Returns None if the file does not exist.
        """
        target = self.agent_dir / "config.json"
        if not target.exists():
            return None
        try:
            text = target.read_text(encoding="utf-8")
            return json.loads(text)
        except Exception as exc:
            logger.warning("Failed to read config for %s: %s", self.agent_id, exc)
            return None

    def write_config(self, data: dict[str, Any]) -> None:
        """Write agent configuration to config.json."""
        target = self.agent_dir / "config.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    def update_config(self, updates: dict[str, Any]) -> dict[str, Any]:
        """Merge updates into existing config and write back.

        Creates a new config if none exists.
        """
        config = self.read_config() or {}
        config.update(updates)
        self.write_config(config)
        return config

    # ------------------------------------------------------------------
    # JSON Lines helpers
    # ------------------------------------------------------------------

    def _read_jsonl(self, path: Path) -> list[dict[str, Any]]:
        """Read all JSON objects from a JSON Lines file."""
        if not path.exists():
            return []
        results: list[dict[str, Any]] = []
        try:
            with path.open("r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line:
                        results.append(json.loads(line))
        except Exception as exc:
            logger.warning("Failed to read JSONL %s for %s: %s", path, self.agent_id, exc)
        return results

    def _append_jsonl(self, path: Path, record: dict[str, Any]) -> None:
        """Append a single JSON object to a JSON Lines file."""
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")

    def _write_jsonl(self, path: Path, records: list[dict[str, Any]]) -> None:
        """Overwrite a JSON Lines file with records."""
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("w", encoding="utf-8") as f:
            for record in records:
                f.write(json.dumps(record, ensure_ascii=False) + "\n")

    # ------------------------------------------------------------------
    # Sessions
    # ------------------------------------------------------------------

    def read_sessions(self) -> list[dict[str, Any]]:
        """Read all chat session metadata."""
        return self._read_jsonl(self._data_path("sessions.jsonl"))

    def write_sessions(self, sessions: list[dict[str, Any]]) -> None:
        """Overwrite all chat session metadata."""
        self._write_jsonl(self._data_path("sessions.jsonl"), sessions)

    def append_session(self, session: dict[str, Any]) -> None:
        """Append a chat session metadata record."""
        self._append_jsonl(self._data_path("sessions.jsonl"), session)

    def filter_sessions(self, predicate: Callable[[dict[str, Any]], bool]) -> list[dict[str, Any]]:
        """Return sessions matching predicate."""
        return [s for s in self.read_sessions() if predicate(s)]

    # ------------------------------------------------------------------
    # Messages per session
    # ------------------------------------------------------------------

    def read_messages(self, session_id: str) -> list[dict[str, Any]]:
        """Read all messages for a given session."""
        return self._read_jsonl(self._message_path(session_id))

    def write_messages(self, session_id: str, messages: list[dict[str, Any]]) -> None:
        """Overwrite all messages for a given session."""
        self._write_jsonl(self._message_path(session_id), messages)

    def append_message(self, session_id: str, message: dict[str, Any]) -> None:
        """Append a message to a session."""
        self._append_jsonl(self._message_path(session_id), message)

    def filter_messages(
        self,
        session_id: str,
        predicate: Callable[[dict[str, Any]], bool],
    ) -> list[dict[str, Any]]:
        """Return messages for a session matching predicate."""
        return [m for m in self.read_messages(session_id) if predicate(m)]

    # ------------------------------------------------------------------
    # LLM sessions
    # ------------------------------------------------------------------

    def read_llm_sessions(self) -> list[dict[str, Any]]:
        """Read all LLM session records."""
        return self._read_jsonl(self._data_path("llm_sessions.jsonl"))

    def write_llm_sessions(self, sessions: list[dict[str, Any]]) -> None:
        """Overwrite all LLM session records."""
        self._write_jsonl(self._data_path("llm_sessions.jsonl"), sessions)

    def append_llm_session(self, session: dict[str, Any]) -> None:
        """Append an LLM session record."""
        self._append_jsonl(self._data_path("llm_sessions.jsonl"), session)

    def filter_llm_sessions(self, predicate: Callable[[dict[str, Any]], bool]) -> list[dict[str, Any]]:
        """Return LLM sessions matching predicate."""
        return [s for s in self.read_llm_sessions() if predicate(s)]

    # ------------------------------------------------------------------
    # LLM messages
    # ------------------------------------------------------------------

    def read_llm_messages(self) -> list[dict[str, Any]]:
        """Read all LLM messages."""
        return self._read_jsonl(self._data_path("llm_messages.jsonl"))

    def write_llm_messages(self, messages: list[dict[str, Any]]) -> None:
        """Overwrite all LLM messages."""
        self._write_jsonl(self._data_path("llm_messages.jsonl"), messages)

    def append_llm_message(self, message: dict[str, Any]) -> None:
        """Append an LLM message record."""
        self._append_jsonl(self._data_path("llm_messages.jsonl"), message)

    def filter_llm_messages(self, predicate: Callable[[dict[str, Any]], bool]) -> list[dict[str, Any]]:
        """Return LLM messages matching predicate."""
        return [m for m in self.read_llm_messages() if predicate(m)]

    # ------------------------------------------------------------------
    # Memories (cross-scene)
    # ------------------------------------------------------------------

    def read_memories(self) -> list[dict[str, Any]]:
        """Read all cross-scene memory records."""
        return self._read_jsonl(self._data_path("memories.jsonl"))

    def write_memories(self, memories: list[dict[str, Any]]) -> None:
        """Overwrite all cross-scene memory records."""
        self._write_jsonl(self._data_path("memories.jsonl"), memories)

    def append_memory(self, memory: dict[str, Any]) -> None:
        """Append a cross-scene memory record."""
        self._append_jsonl(self._data_path("memories.jsonl"), memory)

    def filter_memories(self, predicate: Callable[[dict[str, Any]], bool]) -> list[dict[str, Any]]:
        """Return memories matching predicate."""
        return [m for m in self.read_memories() if predicate(m)]

    # ------------------------------------------------------------------
    # Delete agent
    # ------------------------------------------------------------------

    def delete_all(self) -> None:
        """Delete all agent data (entire workspace directory)."""
        if self.agent_dir.exists():
            shutil.rmtree(self.agent_dir)
            logger.info("Deleted all data for agent %s", self.agent_id)
