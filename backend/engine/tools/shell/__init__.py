"""Shell command execution tools.

Executes shell commands in a subprocess with timeout, output limits,
and an allow-list of safe commands.  Shell chaining metacharacters
(pipes, redirections, command substitution, etc.) are rejected.
"""

from __future__ import annotations

import logging
import subprocess
from pathlib import Path

from ...tool.registry import tool_registry

logger = logging.getLogger(__name__)

# Allow-list: only these commands may be executed.
# If you need to run something else, extend this list consciously.
_ALLOWED_COMMANDS = {
    "ls", "cat", "echo", "pwd", "mkdir", "touch", "cp", "mv",
    "find", "grep", "head", "tail", "wc", "date", "whoami",
    "git", "npm", "yarn", "pip", "pip3", "ps", "df", "du",
}


def _has_unquoted_metachar(command: str) -> bool:
    """Return True if command contains unquoted shell metacharacters.

    Blocks: | ; & < > ( ) $ `
    These enable command chaining, substitution, and redirection.
    """
    in_single = False
    in_double = False
    escaped = False
    for ch in command:
        if escaped:
            escaped = False
            continue
        if ch == "\\":
            escaped = True
            continue
        if ch == "'" and not in_double:
            in_single = not in_single
            continue
        if ch == '"' and not in_single:
            in_double = not in_double
            continue
        if not in_single and not in_double and ch in "|;&<>()$`":
            return True
    return False


def _sanitize_command(command: str) -> tuple[bool, str]:
    """Check if a shell command is safe to run.

    Returns (ok, reason).
    """
    stripped = command.strip()
    if not stripped:
        return False, "empty command"

    # Reject any unquoted shell metacharacter (pipes, redirection, etc.)
    if _has_unquoted_metachar(stripped):
        return (
            False,
            "shell metacharacters (|, ;, &, <, >, $(), `) are not allowed; "
            "run a single simple command only",
        )

    # Extract the first token (the command name)
    # Handle leading env vars like FOO=bar python script.py
    tokens = stripped.split()
    cmd_name = ""
    for tok in tokens:
        if "=" in tok and not tok.startswith("-"):
            continue  # skip env vars
        cmd_name = tok
        break

    if not cmd_name:
        return False, "cannot determine command name"

    # Strip any path prefix to get basename
    base = Path(cmd_name).name.lower()

    if base not in _ALLOWED_COMMANDS:
        return False, f"command not in allow-list: {base}"

    # Block python/python3 -c (arbitrary code execution bypass)
    if base in ("python", "python3"):
        if "-c" in tokens:
            return (
                False,
                "python -c is not allowed; use the python_execute tool instead",
            )

    return True, ""


@tool_registry.register(toolset="shell", max_result_chars=12000, safe_to_parallel=False, timeout=30)
def shell_command(command: str, timeout_seconds: int = 30) -> str:
    """Run a shell command and return stdout + stderr.

    The command executes in a subprocess with a 30-second timeout.
    Only single simple commands from an allow-list are permitted;
    shell metacharacters (|, ;, &, <, >, $(), `) are blocked.

    Allowed commands: ls, cat, echo, pwd, mkdir, touch, cp, mv,
    find, grep, head, tail, wc, date, whoami, git, npm, yarn, pip, ps, df, du.

    Args:
        command: The shell command to run.
        timeout_seconds: Max execution time (default 30, max 120).
    """
    safe, reason = _sanitize_command(command)
    if not safe:
        return f"Error: security check failed — {reason}"

    timeout = max(1, min(timeout_seconds, 120))

    try:
        result = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=timeout,
            # Run from a safe cwd and stripped env
            cwd=str(Path.home()),
            env={"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": str(Path.home())},
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
        return f"Error: command timed out after {timeout}s"
    except Exception as exc:
        logger.exception("shell_command failed: %s", command)
        return f"Error: {type(exc).__name__}: {exc}"
