"""Skill synthesis: detection, macro generation, code synthesis, decay.

Design reference: §6.15 技能合成
"""

from .detector import PatternDetector, SequencePattern
from .macro import SkillMacro, ToolCallTemplate
from .synthesizer import SkillSynthesizer
from .decay import SkillDecay, SkillEntry

__all__ = [
    "PatternDetector",
    "SequencePattern",
    "SkillMacro",
    "ToolCallTemplate",
    "SkillSynthesizer",
    "SkillDecay",
    "SkillEntry",
]