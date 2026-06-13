"""Skill loader: scan and parse SKILL.md files for agents."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


try:
    import yaml
except ImportError:  # pragma: no cover
    yaml = None  # type: ignore[assignment]


@dataclass
class SkillInfo:
    name: str
    description: str
    content: str
    path: str


def _strip_frontmatter(text: str) -> tuple[dict[str, Any], str]:
    text = text.strip()
    if not text.startswith("---"):
        return {}, text
    parts = text.split("---", 2)
    if len(parts) < 3:
        return {}, text
    front_text = parts[1].strip()
    body = parts[2].strip()
    if yaml is None:
        return {}, body
    try:
        meta = yaml.safe_load(front_text) or {}
    except Exception:
        meta = {}
    return meta, body


def _resolve_workspace_root() -> Path:
    try:
        from app.database import WORKSPACE_ROOT
        return WORKSPACE_ROOT
    except ImportError:
        return Path(__file__).resolve().parent.parent.parent.parent / "workspace"


def load_skills(agent_id: str) -> list[SkillInfo]:
    """Scan workspace/{agent_id}/skills/ for SKILL.md files.

    Each subdirectory is expected to contain one SKILL.md.
    Returns a list of SkillInfo sorted by directory name.
    """
    workspace = _resolve_workspace_root()
    skills_dir = workspace / agent_id / "skills"
    if not skills_dir.exists():
        return []

    results: list[SkillInfo] = []
    seen_names: set[str] = set()
    for subdir in sorted(skills_dir.iterdir()):
        if not subdir.is_dir():
            continue
        if subdir.name == "references":
            continue
        skill_file = subdir / "SKILL.md"
        if not skill_file.exists():
            continue
        try:
            text = skill_file.read_text(encoding="utf-8")
            meta, body = _strip_frontmatter(text)
            name = meta.get("name", "") if isinstance(meta, dict) else ""
            description = meta.get("description", "") if isinstance(meta, dict) else ""
            if not name:
                name = subdir.name
            if name in seen_names:
                logger.warning(
                    "Duplicate skill name '%s' in %s; skipping.", name, skill_file
                )
                continue
            seen_names.add(name)
            results.append(
                SkillInfo(
                    name=name,
                    description=description,
                    content=body,
                    path=str(skill_file),
                )
            )
        except Exception as exc:
            logger.warning("Failed to parse skill file %s: %s", skill_file, exc)
            continue

    return results


def build_skill_injection(
    agent_id: str,
    enabled_skills: list[str],
    per_skill_limit: int = 3000,
    total_limit: int = 8000,
) -> str:
    """Build the L1.2 skill instruction block.

    Returns empty string if no matching skills.
    """
    if not enabled_skills:
        return ""

    all_skills = load_skills(agent_id)
    skill_map = {s.name: s for s in all_skills}
    selected: list[SkillInfo] = []
    for name in enabled_skills:
        if name in skill_map:
            selected.append(skill_map[name])

    if not selected:
        return ""

    lines: list[str] = [
        "【技能指令】",
        "以下是你可以使用的额外技能指引。在需要时参考这些指引。",
        "",
    ]
    total_used = 0
    for sk in selected:
        content = sk.content[:per_skill_limit]
        block_len = len(content) + len(sk.name) + 10  # rough estimate for separators
        if total_used + block_len > total_limit and total_used > 0:
            logger.warning(
                "Skill injection exceeded total limit %d for agent %s; truncating.",
                total_limit,
                agent_id,
            )
            break
        lines.append(f"--- {sk.name} ---")
        lines.append(content)
        lines.append("")
        total_used += block_len

    return "\n".join(lines)
