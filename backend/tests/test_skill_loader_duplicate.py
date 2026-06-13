"""Test Q4: duplicate skill names are skipped."""
from __future__ import annotations

import tempfile
from pathlib import Path

from engine.skill.loader import load_skills


def test_load_skills_skips_duplicate_names():
    """Two skill directories with the same frontmatter name: second one skipped."""
    with tempfile.TemporaryDirectory() as tmp:
        agent_dir = Path(tmp) / "agent_01" / "skills"
        skill_a = agent_dir / "skill_a"
        skill_b = agent_dir / "skill_b"
        skill_a.mkdir(parents=True)
        skill_b.mkdir(parents=True)

        (skill_a / "SKILL.md").write_text("---\nname: news\n---\nSkill A content")
        (skill_b / "SKILL.md").write_text("---\nname: news\n---\nSkill B content")

        # Monkey-patch workspace root via loader internals
        import engine.skill.loader as loader_mod
        original_resolve = loader_mod._resolve_workspace_root
        loader_mod._resolve_workspace_root = lambda: Path(tmp)
        try:
            skills = load_skills("agent_01")
            names = [s.name for s in skills]
            assert names.count("news") == 1, f"Expected 1 'news' skill, got {names}"
        finally:
            loader_mod._resolve_workspace_root = original_resolve
