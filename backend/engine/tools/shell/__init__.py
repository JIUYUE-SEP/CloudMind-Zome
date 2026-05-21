"""Shell command execution tools.

Executes shell commands in a subprocess with timeout, output limits,
and a deny-list of dangerous commands / patterns.
"""

from __future__ import annotations

import logging
import re
import subprocess
import sys
from pathlib import Path

from ...tool.registry import tool_registry

logger = logging.getLogger(__name__)

# Commands that are completely blocked
_BLOCKED_COMMANDS = {
    "rm", "dd", "mkfs", "mkfs.ext4", "mkfs.ntfs", "mkfs.fat", "fdisk",
    "parted", "format", "del", "rd", "rmdir", "shutdown", "reboot",
    "poweroff", "halt", "init", "systemctl", "service", "kill", "pkill",
    "killall", "chmod", "chown", "chgrp", "sudo", "su", "doas",
    "passwd", "useradd", "userdel", "usermod", "groupadd", "groupdel",
    "iptables", "ufw", "firewalld", "wget", "curl", "nc", "netcat",
    "nmap", "ssh", "scp", "sftp", "ftp", "telnet", "mount", "umount",
    "mknod", "mkswap", "swapon", "swapoff", "fsck", "dd", "pv",
    "crontab", "at", "batch", "nohup", "screen", "tmux",
    "docker", "podman", "kubectl", "helm",
    "pyenv", "conda", "venv", "virtualenv",  # avoid env mangling
}

# Dangerous patterns in the full command string
_BLOCKED_PATTERNS = [
    r"[|;&]\s*bash\b",       # curl ... | bash
    r"[|;&]\s*sh\b",          # curl ... | sh
    r">\s*/dev/(sd|hd|mmc|nvme)",  # overwrite disk devices
    r"<\s*/dev/zero\b",       # zero-fill
    r"rm\s+-rf\s+/\b",        # rm -rf /
    r":\(\)\{\s*:\|:\&\};:",  # fork bomb
    r"\b(eval|exec)\s+",      # eval / exec
]


def _sanitize_command(command: str) -> tuple[bool, str]:
    """Check if a shell command is safe to run.

    Returns (ok, reason).
    """
    stripped = command.strip()
    if not stripped:
        return False, "empty command"

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

    if base in _BLOCKED_COMMANDS:
        return False, f"blocked command: {base}"

    # Check dangerous patterns
    lower_cmd = stripped.lower()
    for pat in _BLOCKED_PATTERNS:
        if re.search(pat, lower_cmd):
            return False, f"blocked pattern: {pat}"

    return True, ""


@tool_registry.register(toolset="shell", max_result_chars=12000, safe_to_parallel=False, timeout=30)
def shell_command(command: str, timeout_seconds: int = 30) -> str:
    """Run a shell command and return stdout + stderr.

    The command executes in a subprocess with a 30-second timeout.
    Dangerous commands (rm, dd, sudo, curl, ssh, docker, etc.) and
    suspicious patterns (| bash, > /dev/sd*, rm -rf /, fork bombs)
    are blocked automatically.

    Common safe commands: ls, cat, echo, pwd, mkdir, touch, cp, mv,
    find, grep, head, tail, wc, date, whoami, python, python3, git,
    npm, yarn, pip, ps, df, du.

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
