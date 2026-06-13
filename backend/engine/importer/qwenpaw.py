"""QwenPaw conversation history importer.

QwenPaw exports conversations as JSONL:
  - one JSON object per line
  - content is a list of typed blocks:
      {type: "text", text: "..."}
      {type: "tool_use", id: "...", name: "...", input: {...}}
      {type: "tool_result", tool_use_id: "...", content: "..."}
      {type: "thinking", thinking: "..."}
  - fields: id, name, role, timestamp
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone

from .base import ImportAdapter

logger = logging.getLogger(__name__)


class QwenPawAdapter(ImportAdapter):
    """Adapter for QwenPaw exported JSONL files."""

    def platform_name(self) -> str:
        return "qwenpaw"

    def parse(self, file_content: bytes) -> list[dict]:
        """Parse QwenPaw JSONL into unified message format."""
        lines = file_content.decode("utf-8", errors="replace").splitlines()
        messages: list[dict] = []
        for idx, line in enumerate(lines):
            line = line.strip()
            if not line:
                continue
            try:
                raw = json.loads(line)
            except json.JSONDecodeError as e:
                logger.warning("QwenPaw adapter: skip invalid JSON at line %d: %s", idx + 1, e)
                continue

            msg = self._convert_message(raw)
            if msg:
                messages.append(msg)
        return messages

    def _convert_message(self, raw: dict) -> dict | None:
        """Convert a single QwenPaw message dict to unified format."""
        role = self._normalize_role(raw.get("role", ""))
        content_blocks = raw.get("content")
        if not isinstance(content_blocks, list):
            # Fallback: content may already be a string
            content_blocks = [{"type": "text", "text": str(content_blocks) if content_blocks else ""}]

        text_parts: list[str] = []
        thinking_parts: list[str] = []
        tool_use_list: list[dict] = []
        tool_result_id: str | None = None
        tool_result_content: str | None = None
        tool_name: str | None = None

        for block in content_blocks:
            if not isinstance(block, dict):
                continue
            btype = block.get("type", "")
            if btype == "text":
                t = block.get("text", "")
                if t:
                    text_parts.append(t)
            elif btype == "thinking":
                t = block.get("thinking", "")
                if t:
                    thinking_parts.append(t)
            elif btype == "tool_use":
                tool_use_list.append({
                    "id": block.get("id", ""),
                    "name": block.get("name", ""),
                    "input": block.get("input", {}),
                })
                if not tool_name:
                    tool_name = block.get("name", "")
            elif btype == "tool_result":
                tool_result_id = block.get("tool_use_id") or block.get("id", "")
                tool_result_content = block.get("content", "")
                # If this message is mixed, treat tool_result as the primary content
                # and set role to "tool"
                role = "tool"

        # Determine final content
        content = "\n".join(text_parts) if text_parts else ""
        if role == "tool" and tool_result_content is not None:
            content = str(tool_result_content)

        # Tool calls JSON
        tool_calls: str | None = None
        if tool_use_list:
            tool_calls = json.dumps(tool_use_list, ensure_ascii=False)

        # Reasoning content
        reasoning_content = "\n".join(thinking_parts) if thinking_parts else None

        # Timestamp normalization
        ts_raw = raw.get("timestamp")
        timestamp = self._normalize_timestamp(ts_raw)

        # UUID
        msg_uuid = raw.get("id", "")
        if not msg_uuid:
            import uuid as _uuid
            msg_uuid = str(_uuid.uuid4())

        # Sender name
        sender_name = raw.get("name", "")
        if not sender_name and role == "assistant":
            sender_name = raw.get("agent_name", "")

        return {
            "role": role,
            "content": content,
            "tool_calls": tool_calls,
            "reasoning_content": reasoning_content,
            "tool_call_id": tool_result_id,
            "tool_name": tool_name,
            "sender_name": sender_name,
            "timestamp": timestamp,
            "message_uuid": msg_uuid,
        }

    @staticmethod
    def _normalize_role(role: str) -> str:
        r = role.lower().strip()
        if r in ("user", "assistant", "system", "tool"):
            return r
        # QwenPaw sometimes marks tool results as system
        if r in ("model",):
            return "assistant"
        return "user"

    @staticmethod
    def _normalize_timestamp(ts) -> str:
        if isinstance(ts, (int, float)):
            try:
                dt = datetime.fromtimestamp(ts, tz=timezone.utc)
                return dt.isoformat()
            except Exception:
                pass
        if isinstance(ts, str):
            # Try to parse ISO format
            try:
                # Ensure it ends with timezone info
                if ts.endswith("Z"):
                    ts = ts[:-1] + "+00:00"
                dt = datetime.fromisoformat(ts)
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                return dt.isoformat()
            except Exception:
                return ts
        return datetime.now(timezone.utc).isoformat()
