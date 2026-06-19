"""Code execution tools: subprocess-based Python runner with sandboxing.

Executes Python code in a fresh subprocess with:
- AST deny-list for obvious abuses
- runtime import blocking via meta path finder
- restricted builtins subset
- stripped environment variables
- dedicated temp working directory
- timeout with explicit process kill
- deterministic, collision-free temp file names
"""

from __future__ import annotations

import ast
import base64
import logging
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

from ...tool.registry import tool_registry

logger = logging.getLogger(__name__)

# Dangerous modules / functions that are blocked statically.
_BLOCKED_IMPORTS = {
    "os", "sys", "subprocess", "shutil", "socket", "urllib", "http",
    "ftplib", "smtplib", "ctypes", "mmap", "resource", "signal",
    "multiprocessing", "concurrent", "threading", "asyncio", "importlib",
    "pathlib", "io", "builtins", "pkgutil", "platform", "site",
    "zipfile", "tarfile", "pickle", "marshal", "shelve", "dbm",
}

_BLOCKED_BUILTINS = {
    "open", "exec", "eval", "compile", "__import__", "input",
    "breakpoint", "exit", "quit",
}


# Path to the in-process sandbox runner (imported in the child).
_SANDBOX_RUNNER = Path(__file__).with_name("sandbox_runner.py")


def _is_code_safe(source: str) -> tuple[bool, str]:
    """Quick AST scan to catch dangerous imports and builtins.

    Returns (ok, reason).
    """
    try:
        tree = ast.parse(source)
    except SyntaxError as exc:
        return False, f"Syntax error at line {exc.lineno}: {exc.msg}"

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                top = alias.name.split(".")[0]
                if top in _BLOCKED_IMPORTS:
                    return False, f"Blocked import: {alias.name}"

        if isinstance(node, ast.ImportFrom):
            top = (node.module or "").split(".")[0]
            if top in _BLOCKED_IMPORTS:
                return False, f"Blocked import: {node.module}"

        if isinstance(node, ast.Call):
            func = node.func
            if isinstance(func, ast.Name) and func.id in _BLOCKED_BUILTINS:
                return False, f"Blocked builtin call: {func.id}()"
            if isinstance(func, ast.Attribute) and func.attr in _BLOCKED_BUILTINS:
                return False, f"Blocked method call: {func.attr}()"

    return True, ""


def _build_safe_env() -> dict[str, str]:
    """Return a minimal environment for the child process."""
    return {
        "PYTHONPATH": str(_SANDBOX_RUNNER.parent.parent.parent.parent),
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONNOUSERSITE": "1",
        "PATH": "/usr/bin:/bin",
    }


def _kill_process(proc: subprocess.Popen) -> None:
    """Kill a process and its children on timeout."""
    try:
        proc.kill()
    except Exception:
        pass


@tool_registry.register(toolset="code", max_result_chars=12000, safe_to_parallel=False, timeout=30)
def python_execute(code: str, timeout_seconds: int = 30) -> str:
    """Execute a snippet of Python code safely and return stdout + stderr.

    The code runs in a fresh subprocess with a 30-second timeout.
    Dangerous imports (os, sys, subprocess, etc.) and builtins (open, exec, eval)
    are blocked automatically, both statically (AST) and at runtime.

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

    # Use a dedicated temp directory as cwd and for the script file.
    tmp_dir = Path(tempfile.gettempdir()) / f"zome_exec_{uuid.uuid4().hex}"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    runner_path = tmp_dir / "__runner__.py"

    try:
        # Copy the sandbox runner into the temp dir so PYTHONPATH stays minimal.
        runner_code = _SANDBOX_RUNNER.read_text(encoding="utf-8")
        runner_path.write_text(runner_code, encoding="utf-8")

        encoded_code = base64.b64encode(code.encode("utf-8")).decode("ascii")

        proc = subprocess.Popen(
            [sys.executable, "-I", "-S", str(runner_path), encoded_code],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=_build_safe_env(),
            cwd=str(tmp_dir),
        )
        try:
            stdout, stderr = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            _kill_process(proc)
            stdout, stderr = proc.communicate()
            return f"Error: execution timed out after {timeout}s"

        lines: list[str] = []
        if stdout:
            lines.append("[stdout]")
            lines.append(stdout.rstrip("\n"))
        if stderr:
            lines.append("[stderr]")
            lines.append(stderr.rstrip("\n"))
        if proc.returncode != 0:
            lines.append(f"[exit code: {proc.returncode}]")

        return "\n".join(lines) if lines else "(no output)"

    except Exception as exc:
        logger.exception("python_execute failed")
        return f"Error: {type(exc).__name__}: {exc}"
    finally:
        # Best-effort cleanup
        try:
            runner_path.unlink(missing_ok=True)
            tmp_dir.rmdir()
        except Exception:
            pass
