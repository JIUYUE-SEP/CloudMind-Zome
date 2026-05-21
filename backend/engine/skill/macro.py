"""Skill macro: template-based recorded replay.

Design reference: §6.15.3 模板宏（Phase 1）
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable


@dataclass
class ToolCallTemplate:
    """Template for a single tool call in a sequence."""

    name: str
    # Mapping: user_param -> tool_param_path
    # e.g. {"query_a": "search.query"} means user provides 'query_a',
    # and it's passed as the 'query' argument to the 'search' tool
    param_mapping: dict[str, str] = field(default_factory=dict)


@dataclass
class SkillMacro:
    """A recorded tool call sequence that can be replayed with new parameters.

    Design reference: §6.15.3
    """

    name: str
    description: str = ""
    sequence: list[ToolCallTemplate] = field(default_factory=list)
    call_count: int = 0
    retry_count: int = 0
    last_called_at: float = 0.0
    created_at: float = 0.0

    def build_schema(self) -> dict:
        """Build OpenAI function schema for this macro."""
        # Collect all unique user parameters
        params: dict[str, dict[str, Any]] = {}
        for step in self.sequence:
            for user_param in step.param_mapping.keys():
                if user_param not in params:
                    params[user_param] = {"type": "string", "description": f"Parameter: {user_param}"}

        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": {
                    "type": "object",
                    "properties": params,
                    "required": list(params.keys()),
                },
            },
        }

    def replay(self, arguments: dict[str, Any]) -> list[dict[str, Any]]:
        """Generate tool calls from user arguments.

        Args:
            arguments: User-provided arguments.

        Returns:
            List of tool call dicts to execute.
        """
        calls = []
        for step in self.sequence:
            tool_args: dict[str, Any] = {}
            for user_param, tool_path in step.param_mapping.items():
                if user_param in arguments:
                    # Simple nested path support: "search.query" -> {"search": {"query": value}}
                    parts = tool_path.split(".")
                    target = tool_args
                    for part in parts[:-1]:
                        if part not in target:
                            target[part] = {}
                        target = target[part]
                    target[parts[-1]] = arguments[user_param]

            calls.append({"name": step.name, "arguments": tool_args})

        return calls
