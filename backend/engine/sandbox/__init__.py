"""Sandbox: work copies, testing, merging, rollback, isolated execution."""

from .manager import SandboxManager, ModificationRequest, TestResult, ApprovalResult
from .executor import SandboxExecutor

__all__ = [
    "SandboxManager",
    "ModificationRequest",
    "TestResult",
    "ApprovalResult",
    "SandboxExecutor",
]