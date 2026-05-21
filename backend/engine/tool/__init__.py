"""Tool registry and schema generation.

Design reference: §6.5 工具接口规范
"""

from .registry import ToolRegistry, tool_registry

__all__ = ["ToolRegistry", "tool_registry"]