"""Code execution tools: subprocess-based Python runner.

Executes Python code in a subprocess with timeout and output limits.
Dangerous operations are blocked by a simple AST-based deny-list.
"""

from __future__ import annotations

import ast
import logging
import re
import subprocess
import sys
import tempfile
from pathlib import Path

from ...tool.registry import tool_registry

logger = logging.getLogger(__name__)

# Dangerous modules / functions that are blocked
_BLOCKED_IMPORTS = {
    "os", "sys", "subprocess", "shutil", "socket", "urllib", "http",
    "ftplib", "smtplib", "ctypes", "mmap", "resource", "signal",
    "multiprocessing", "concurrent", "threading", "asyncio", "importlib",
    "pathlib", "io", "builtins",
}

_BLOCKED_BUILTINS = {
    "open", "exec", "eval", "compile", "__import__", "input",
    "breakpoint", "exit", "quit",
}


def _is_code_safe(source: str) -> tuple[bool, str]:
    """Quick AST scan to catch dangerous imports and builtins.

    Returns (ok, reason).
    """
    try:
        tree = ast.parse(source)
    except SyntaxError as exc:
        return False, f"Syntax error at line {exc.lineno}: {exc.msg}"

    for node in ast.walk(tree):
        # Detect 'import os' or 'from os import ...'
        if isinstance(node, ast.Import):
            for alias in node.names:
                top = alias.name.split(".")[0]
                if top in _BLOCKED_IMPORTS:
                    return False, f"Blocked import: {alias.name}"

        if isinstance(node, ast.ImportFrom):
            top = (node.module or "").split(".")[0]
            if top in _BLOCKED_IMPORTS:
                return False, f"Blocked import: {node.module}"

        # Detect open(), exec(), eval(), __import__()
        if isinstance(node, ast.Call):
            func = node.func
            if isinstance(func, ast.Name) and func.id in _BLOCKED_BUILTINS:
                return False, f"Blocked builtin call: {func.id}()"
            if isinstance(func, ast.Attribute) and func.attr in _BLOCKED_BUILTINS:
                return False, f"Blocked method call: {func.attr}()"

    return True, ""


@tool_registry.register(toolset="code", max_result_chars=12000, safe_to_parallel=False, timeout=30)
def python_execute(code: str, timeout_seconds: int = 30) -> str:
    """Execute a snippet of Python code safely and return stdout + stderr.

    The code runs in a fresh subprocess with a 30-second timeout.
    Dangerous imports (os, sys, subprocess, etc.) and builtins (open, exec, eval)
    are blocked automatically.

    Args:
        code: Python source code to run.
        timeout_seconds: Max execution time (default 30, max 120).
    """
    if not code.strip():
        return "Error: empty code"

    safe, reason = _is_code_safe(code)
    if not safe:
        return f"Error: security check failed — {reason}"

    timeout = max(1, min(timeout_seconds, 120))

    # Write code to a temp file so we can run it cleanly
    tmp_path = Path(tempfile.gettempdir()) / f"zome_exec_{id(code)}.py"
    try:
        tmp_path.write_text(code, encoding="utf-8")

        result = subprocess.run(
            [sys.executable, str(tmp_path)],
            capture_output=True,
            text=True,
            timeout=timeout,
            env={"PYTHONPATH": "", "PATH": "/usr/bin:/bin"},  # strip env
        )

        lines: list[str] = []
        if result.stdout:
            lines.append("[stdout]")
            lines.append(result.stdout.rstrip("\n"))
        if result.stderr:
            lines.append("[stderr]")
            lines.append(result.stderr.rstrip("\n"))
        if result.returncode != 0:
            lines.append(f"[exit code: {result.returncode}]")

        return "\n".join(lines) if lines else "(no output)"

    except subprocess.TimeoutExpired:
        return f"Error: execution timed out after {timeout}s"
    except Exception as exc:
        logger.exception("python_execute failed")
        return f"Error: {type(exc).__name__}: {exc}"
    finally:
        # Best-effort cleanup
        try:
            tmp_path.unlink(missing_ok=True)
        except Exception:
            pass
