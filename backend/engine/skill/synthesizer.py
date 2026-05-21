"""LLM-based skill code generator (Phase 2 upgrade).

Design reference: §6.15.4 LLM 生成代码（Phase 2）
"""

from __future__ import annotations

import logging
from typing import Any

from ..message.types import Message

logger = logging.getLogger(__name__)


class SkillSynthesizer:
    """Generates Python code for a skill using LLM.

    Upgrades a SkillMacro to a proper Python function when the macro
    proves insufficient (too many retries needed).
    """

    def __init__(self, model: Any):
        self.model = model

    async def synthesize(
        self,
        skill_name: str,
        tool_sequence: list[dict],
        example_usage: list[dict],
    ) -> str:
        """Generate Python code for a skill.

        Args:
            skill_name: Name for the new skill.
            tool_sequence: Sequence of tool calls the skill should make.
            example_usage: Example argument sets showing how it's used.

        Returns:
            Python source code for the skill function.
        """
        prompt = self._build_synthesis_prompt(skill_name, tool_sequence, example_usage)

        try:
            response = await self.model.chat(
                messages=[
                    Message(role="system", content="You are a Python code generator for AI agent skills."),
                    Message(role="user", content=prompt),
                ],
                tools=None,
            )
            return response.content or ""
        except Exception as e:
            logger.error("Skill synthesis failed: %s", e)
            return ""

    def _build_synthesis_prompt(
        self,
        skill_name: str,
        tool_sequence: list[dict],
        example_usage: list[dict],
    ) -> str:
        """Build the prompt for code synthesis."""
        seq_str = "\n".join(
            f"  {i+1}. {tc['name']}({tc.get('arguments', {})})"
            for i, tc in enumerate(tool_sequence)
        )

        examples_str = "\n\n".join(
            f"Example {i+1}:\n  Input: {ex.get('input', {})}\n  Output: {ex.get('output', '')}"
            for i, ex in enumerate(example_usage)
        )

        return f"""Generate a Python function named `{skill_name}` that encapsulates this tool sequence:

Tool sequence:
{seq_str}

{examples_str}

Requirements:
1. Function should accept parameters that map to the tool inputs
2. Add error handling and retries where appropriate
3. Include type hints and docstring
4. Return a string summarizing the results
5. Use conditional logic when needed (e.g., empty results, retry with different params)

Generate ONLY the Python function code, no explanation."""
