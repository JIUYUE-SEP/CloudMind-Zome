"""MindWorkspace: per-agent workspace file manager.

Manages reading/writing of agent mental workspace files and initialization
from the project template.
"""

from __future__ import annotations

import logging
import re
import shutil
from datetime import datetime, timezone, timedelta
from pathlib import Path

logger = logging.getLogger(__name__)

# Template ships inside the package (backend/engine/agent/workspace_template/).
# Resolved relative to this file so it works regardless of CWD.
_TEMPLATE_DIR = Path(__file__).resolve().parent / "workspace_template"


def _strip_frontmatter(text: str) -> str:
    text = text.strip()
    if text.startswith("---"):
        parts = text.split("---", 2)
        if len(parts) >= 3:
            text = parts[2].strip()
    return text


class MindWorkspace:
    """Read/write helper for a single agent's workspace."""

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

    def path(self, relative: str) -> Path:
        return self.agent_dir / relative

    def read_file(self, relative: str, strip_frontmatter: bool = True) -> str | None:
        target = self.path(relative)
        if not target.exists():
            return None
        try:
            text = target.read_text(encoding="utf-8")
        except Exception as exc:
            logger.warning("Failed to read %s for %s: %s", target, self.agent_id, exc)
            return None
        if strip_frontmatter:
            text = _strip_frontmatter(text)
        return text

    def write_file(self, relative: str, content: str) -> None:
        target = self.path(relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")

    def append_file(self, relative: str, content: str, header: str = "") -> None:
        target = self.path(relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists():
            existing = target.read_text(encoding="utf-8").rstrip()
            text = existing + "\n\n" + content
        else:
            text = content
        if header:
            text = header.rstrip() + "\n\n" + text
        target.write_text(text, encoding="utf-8")

    def ensure_agent_workspace(self) -> None:
        """Copy project workspace template to this agent's runtime workspace.

        If the agent directory already exists, only missing files/directories
        are copied so existing user edits are preserved.
        """
        if not _TEMPLATE_DIR.exists():
            logger.warning("Workspace template not found at %s", _TEMPLATE_DIR)
            return

        self.agent_dir.mkdir(parents=True, exist_ok=True)

        ignore = shutil.ignore_patterns(".git", "__pycache__", "*.pyc")

        if not any(self.agent_dir.iterdir()):
            shutil.copytree(_TEMPLATE_DIR, self.agent_dir, dirs_exist_ok=True, ignore=ignore)
            logger.info("Initialized workspace for %s from template", self.agent_id)
            return

        # Merge missing files/directories only.
        for src in _TEMPLATE_DIR.rglob("*"):
            rel = src.relative_to(_TEMPLATE_DIR)
            dst = self.agent_dir / rel
            if src.is_dir():
                dst.mkdir(parents=True, exist_ok=True)
            elif not dst.exists():
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)
        logger.info("Ensured workspace files for %s", self.agent_id)

    def list_recent_memory(self, days: int = 2) -> list[tuple[str, str]]:
        memory_dir = self.path("memory")
        if not memory_dir.exists():
            return []
        pattern = re.compile(r"^\d{4}-\d{2}-\d{2}\.md$")
        files = [
            (f.name[:-3], f)
            for f in memory_dir.iterdir()
            if f.is_file() and pattern.match(f.name)
        ]
        files.sort(key=lambda x: x[0], reverse=True)
        results = []
        for date_str, f in files[:days]:
            try:
                text = f.read_text(encoding="utf-8")
            except Exception as exc:
                logger.warning("Failed to read memory %s: %s", f, exc)
                continue
            results.append((date_str, text))
        return results

    def load_mind_context(self, source: str = "private") -> str:
        """Assemble the full mind context injected at the start of each turn.

        Sources:
          - AGENTS.md: working rules
          - IDENTITY.md: core identity
          - PROFILE.md: public profile
          - SOUL.md: soul/personality core
          - USER.md: perception of the user
          - HEARTBEAT.md: periodic task checklist
          - memory/YYYY-MM-DD.md: recent daily notes
          - MEMORY.md: long-term memory (private sessions only)
        """
        parts: list[str] = []

        # 1. Global user profile (read-only to agent)
        try:
            from app.database import DATA_DIR
            user_profile = DATA_DIR / "userdata" / "profile.md"
            if user_profile.exists():
                text = _strip_frontmatter(user_profile.read_text(encoding="utf-8"))
                if text:
                    parts.append(f"【用户档案】\n{text}")
        except Exception as exc:
            logger.warning("Failed to read userdata/profile.md: %s", exc)

        files = [
            ("AGENTS.md", "【工作规范】"),
            ("IDENTITY.md", "【身份核心】"),
            ("PROFILE.md", "【对外资料】"),
            ("SOUL.md", "【灵魂内核】"),
            ("USER.md", "【眼中的用户】"),
            ("HEARTBEAT.md", "【心跳任务】"),
        ]

        for filename, header in files:
            text = self.read_file(filename)
            if text:
                parts.append(f"{header}\n{text}")

        # Recent daily memory notes
        recent = self.list_recent_memory(days=2)
        if recent:
            lines = []
            for date_str, text in recent:
                lines.append(f"### {date_str}\n{text.strip()}")
            parts.append("【近日记忆】\n" + "\n\n".join(lines))

        # Long-term memory is private-session only
        if source == "private":
            memory = self.read_file("MEMORY.md")
            if memory:
                parts.append(f"【长期记忆】\n{memory}")

        return "\n\n".join(parts)

    def append_daily_note(
        self,
        content: str,
        also_append_memory: bool = False,
    ) -> None:
        """Append a timestamped note to today's memory file.

        Optionally also append to MEMORY.md for significant events.
        """
        tz_sh = timezone(timedelta(hours=8))
        now = datetime.now(tz_sh)
        date_str = now.strftime("%Y-%m-%d")
        time_str = now.strftime("%H:%M")

        note = f"#### {time_str}\n{content.strip()}"
        self.append_file(f"memory/{date_str}.md", note)

        if also_append_memory:
            self.append_file(
                "MEMORY.md",
                f"{date_str} {time_str}\n{content.strip()}",
            )
