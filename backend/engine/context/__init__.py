"""Context management: hot/warm/cold memory, topic compression, token estimation.

Design reference: §6.4 上下文注入策略
"""

from .manager import ContextManager

__all__ = ["ContextManager"]