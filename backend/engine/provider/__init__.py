"""Provider Transport layer and ThinkingProfile.

Design reference: §6.2 Provider 层
"""

from .transport import ChatCompletionsTransport
from .thinking.base import ThinkingProfile
from .thinking.deepseek import DeepSeekThinkingProfile
from .thinking.mimo import MiMoThinkingProfile
from .thinking.kimicode import KimiCodeThinkingProfile
from .thinking.glm import GLMThinkingProfile

__all__ = [
    "ChatCompletionsTransport",
    "ThinkingProfile",
    "DeepSeekThinkingProfile",
    "MiMoThinkingProfile",
    "KimiCodeThinkingProfile",
    "GLMThinkingProfile",
]