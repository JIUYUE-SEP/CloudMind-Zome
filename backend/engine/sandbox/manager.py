"""Sandbox manager: work copies, testing, merging, rollback.

Design reference: §6.16 沙箱与自我进化
"""

from __future__ import annotations

import logging
import shutil
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

logger = logging.getLogger(__name__)


@dataclass
class ModificationRequest:
    """Agent modification request for approval.

    Design reference: §6.16.3 修改说明
    """

    tool_name: str
    reason: str
    changes: str
    expected_effect: str
    risk_level: Literal["minor", "functional", "breaking"]
    diff: str
    test_results: list[str]


class SandboxManager:
    """Manages sandboxed tool modifications.

    Design reference: §6.16.2 权限闭环
    """

    def __init__(
        self,
        tool_dir: Path | str = "./tools",
        sandbox_dir: Path | str = "./.sandbox",
        backup_dir: Path | str = "./.backups",
    ):
        self.tool_dir = Path(tool_dir)
        self.sandbox_dir = Path(sandbox_dir)
        self.backup_dir = Path(backup_dir)

        self.sandbox_dir.mkdir(parents=True, exist_ok=True)
        self.backup_dir.mkdir(parents=True, exist_ok=True)

    def fork(self, tool_name: str) -> Path:
        """Create a work copy of a tool.

        Args:
            tool_name: Tool name (without .py extension).

        Returns:
            Path to the sandbox copy.
        """
        original = self.tool_dir / f"{tool_name}.py"
        sandbox_copy = self.sandbox_dir / f"{tool_name}.py"

        if original.exists():
            shutil.copy2(original, sandbox_copy)
        else:
            # Create empty file if tool doesn't exist yet
            sandbox_copy.write_text("# Sandbox tool\n", encoding="utf-8")

        logger.info("Forked %s -> %s", original, sandbox_copy)
        return sandbox_copy

    async def run_tests(self, tool_name: str, test_code: str) -> TestResult:
        """Run tests on the sandbox copy.

        Args:
            tool_name: Tool name.
            test_code: Test code to execute.

        Returns:
            TestResult with pass/fail info.
        """
        sandbox_copy = self.sandbox_dir / f"{tool_name}.py"

        # Simple test execution in isolated subprocess
        import subprocess
        import tempfile

        try:
            with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False) as f:
                f.write(f"import sys\nsys.path.insert(0, '{self.sandbox_dir}')\n")
                f.write(sandbox_copy.read_text(encoding="utf-8"))
                f.write("\n\n# Tests\n")
                f.write(test_code)
                test_file = f.name

            result = subprocess.run(
                ["python", test_file],
                capture_output=True,
                text=True,
                timeout=60,
            )

            success = result.returncode == 0
            return TestResult(
                success=success,
                stdout=result.stdout,
                stderr=result.stderr,
            )
        except Exception as e:
            return TestResult(success=False, stdout="", stderr=str(e))
        finally:
            import os

            if "test_file" in dir():
                os.unlink(test_file)

    def approve(self, request: ModificationRequest) -> ApprovalResult:
        """Determine approval strategy based on risk level.

        Design reference: §6.16.4 分级审批
        """
        if request.risk_level == "minor":
            return ApprovalResult(auto_merge=True, needs_human=False)
        elif request.risk_level == "functional":
            return ApprovalResult(auto_merge=False, needs_human=True)
        else:  # breaking
            return ApprovalResult(
                auto_merge=False, needs_human=True, needs_full_regression=True
            )

    def merge(self, tool_name: str, approval: ApprovalResult) -> bool:
        """Merge sandbox copy to main tool directory.

        Args:
            tool_name: Tool name.
            approval: Approval result.

        Returns:
            True if merged successfully.
        """
        if not approval.auto_merge and not approval.human_approved:
            logger.warning("Merge rejected for %s: not approved", tool_name)
            return False

        sandbox_copy = self.sandbox_dir / f"{tool_name}.py"
        original = self.tool_dir / f"{tool_name}.py"

        # Backup original
        if original.exists():
            backup = self.backup_dir / f"{tool_name}.{int(time.time())}.py"
            shutil.copy2(original, backup)
            logger.info("Backup created: %s", backup)

        # Merge
        shutil.copy2(sandbox_copy, original)
        logger.info("Merged %s to %s", sandbox_copy, original)
        return True

    def rollback(self, tool_name: str) -> bool:
        """Rollback to the most recent backup.

        Args:
            tool_name: Tool name.

        Returns:
            True if rollback succeeded.
        """
        original = self.tool_dir / f"{tool_name}.py"

        # Find most recent backup
        backups = sorted(self.backup_dir.glob(f"{tool_name}.*.py"))
        if not backups:
            logger.error("No backup found for %s", tool_name)
            return False

        latest_backup = backups[-1]
        shutil.copy2(latest_backup, original)
        logger.info("Rolled back %s from %s", tool_name, latest_backup)
        return True


@dataclass
class TestResult:
    """Test execution result."""

    success: bool
    stdout: str
    stderr: str


@dataclass
class ApprovalResult:
    """Approval decision."""

    auto_merge: bool = False
    needs_human: bool = False
    needs_full_regression: bool = False
    human_approved: bool = False
