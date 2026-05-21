"""Skill synthesis orchestrator: full loop from detection to decay.

Design reference: §6.15.2 技能进化路径
"""

from __future__ import annotations

import logging
from typing import Any

from ..tool.registry import ToolRegistry
from ..message.types import Message
from .detector import PatternDetector
from .macro import SkillMacro, ToolCallTemplate
from .synthesizer import SkillSynthesizer
from .decay import SkillDecay

logger = logging.getLogger(__name__)


class SkillOrchestrator:
    """Full skill synthesis loop.

    1. Detect repeated patterns via PatternDetector
    2. Create SkillMacro (Phase 1)
    3. Track macro usage; if insufficient, upgrade via SkillSynthesizer (Phase 2)
    4. Register to ToolRegistry
    5. Periodically check decay via SkillDecay
    """

    def __init__(
        self,
        registry: ToolRegistry,
        model: Any,
    ):
        self.registry = registry
        self.model = model
        self.detector = PatternDetector()
        self.synthesizer = SkillSynthesizer(model)
        self.decay = SkillDecay(registry)

        # Track macros waiting for upgrade evaluation
        self._macros: dict[str, SkillMacro] = {}

    def record(self, tool_calls: list[dict]) -> None:
        """Record tool calls for pattern detection."""
        self.detector.record(tool_calls)

    async def check_and_create(self) -> str | None:
        """Check for patterns and create skills if found.

        Returns:
            Name of created skill, or None.
        """
        # Try different sequence lengths
        pattern = None
        for length in range(5, 1, -1):
            pattern = self.detector.detect(sequence_length=length)
            if pattern:
                break
        if not pattern:
            return None

        # Build macro from detected pattern
        sequence = [
            ToolCallTemplate(
                name=name,
                param_mapping=self._infer_param_mapping(name),
            )
            for name in pattern.sequence
        ]

        skill_name = f"skill_{'_'.join(pattern.sequence)}"
        macro = SkillMacro(
            name=skill_name,
            description=f"Auto-generated skill: {' → '.join(pattern.sequence)}",
            sequence=sequence,
            created_at=__import__("time").time(),
        )

        self._macros[skill_name] = macro
        self.decay.register(skill_name, macro.replay)

        # Register macro as a tool
        schema = macro.build_schema()
        self.registry._tools[skill_name] = {
            "func": None,  # Will be handled by execute override
            "toolset": "synthesized",
            "schema": schema,
            "max_result_chars": 50000,
            "safe_to_parallel": False,
            "timeout": 120,
            "is_async": True,
            "_skill_macro": macro,
        }

        logger.info("Created skill macro: %s", skill_name)
        return skill_name

    async def evaluate_and_upgrade(self, skill_name: str) -> bool:
        """Evaluate a skill and upgrade to code if needed.

        Upgrade condition: macro executed 3+ times, 2+ times needed retry.

        Returns:
            True if upgraded.
        """
        macro = self._macros.get(skill_name)
        if not macro:
            return False

        if macro.call_count < 3:
            return False

        if macro.retry_count < 2:
            return False

        # Upgrade to LLM-generated code
        logger.info("Upgrading skill %s to code (retries: %d)", skill_name, macro.retry_count)

        tool_sequence = [
            {"name": t.name, "arguments": {}}
            for t in macro.sequence
        ]

        code = await self.synthesizer.synthesize(
            skill_name=skill_name,
            tool_sequence=tool_sequence,
            example_usage=[
                {"input": {}, "output": "mock"}
            ],
        )

        if not code:
            logger.error("Skill upgrade failed for %s", skill_name)
            return False

        # Phase 1: Validate in sandbox before loading into main process
        from ..sandbox.executor import SandboxExecutor
        executor = SandboxExecutor(timeout=60)
        sandbox_result = await executor.execute(code, inputs={})

        if not sandbox_result["success"]:
            logger.error(
                "Skill code failed sandbox validation for %s: %s",
                skill_name,
                sandbox_result["stderr"],
            )
            return False

        # Phase 2: Load validated code into main process
        local_ns: dict[str, Any] = {}
        try:
            exec(code, {"__builtins__": __builtins__}, local_ns)
            func = local_ns.get(skill_name)
            if not func:
                logger.error("Generated code missing function %s", skill_name)
                return False

            # Replace macro with generated function in registry
            self.registry._tools[skill_name]["func"] = func
            self.registry._tools[skill_name]["_skill_macro"] = None
            self.registry._tools[skill_name]["_skill_code"] = code

            logger.info("Skill %s upgraded to code (sandbox validated)", skill_name)
            return True
        except Exception as e:
            logger.error("Failed to execute generated skill code: %s", e)
            return False

    def _infer_param_mapping(self, tool_name: str) -> dict[str, str]:
        """Infer parameter mapping from tool name."""
        # Simple heuristic: if tool is 'search', map 'query'
        # In production, this would use the tool schema
        if "search" in tool_name.lower():
            return {"query": "query"}
        return {}

    async def check_decay(self) -> list[str]:
        """Run decay check and return removed skills."""
        return self.decay.check_decay()
