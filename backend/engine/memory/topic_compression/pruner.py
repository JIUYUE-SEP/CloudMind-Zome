"""Tool result size pruner."""
from __future__ import annotations

import logging
import uuid
from pathlib import Path

from ...message.types import ToolResultBlock

logger = logging.getLogger(__name__)


class ToolResultPruner:
    def __init__(
        self,
        agent_id: str,
        old_max_bytes: int = 3000,
        recent_max_bytes: int = 50000,
        recent_rounds: int = 3,
    ):
        self.agent_id = agent_id
        self.old_max_bytes = old_max_bytes
        self.recent_max_bytes = recent_max_bytes
        self.recent_rounds = recent_rounds
        try:
            from app.database import WORKSPACE_ROOT
        except ImportError:
            WORKSPACE_ROOT = Path(__file__).resolve().parent.parent.parent.parent.parent / "workspace"

        self.cache_dir = WORKSPACE_ROOT / agent_id / "tool_results_cache"
        self.cache_dir.mkdir(parents=True, exist_ok=True)

    def prune(
        self, result: ToolResultBlock, current_round: int, msg_round: int
    ) -> ToolResultBlock:
        content = str(result.content)
        limit = (
            self.recent_max_bytes
            if (current_round - msg_round) <= self.recent_rounds
            else self.old_max_bytes
        )

        if len(content.encode("utf-8")) <= limit:
            return result

        # Save full content to cache
        cache_id = uuid.uuid4().hex
        cache_path = self.cache_dir / f"{cache_id}.md"
        cache_path.write_text(content, encoding="utf-8")

        # Return truncated + hint
        truncated = content[:limit]
        truncated += (
            f"\n\n[Result truncated. Full content saved to: {cache_path}]"
        )

        return ToolResultBlock(
            id=result.id,
            content=truncated,
            truncated=True,
            cache_path=str(cache_path),
            metadata={"cache_path": str(cache_path), **(result.metadata or {})},
        )
