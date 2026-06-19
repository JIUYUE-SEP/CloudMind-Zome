"""Unified path security for file tools.

All file tools (read, write, edit, delete, share) use this module
for path validation.  Two layers of defence:

1. Blacklist (hard-coded, never bypassable): system-critical paths
   and sensitive user files (SSH keys, password databases, etc.).
2. Whitelist (configurable per-agent): default bases plus
   agent-specific paths from the database.

The whitelist is wider for mode="read" (includes project source so
agents can learn/debug their own code) and stricter for
mode="write"/"delete"/"share".

Agent-specific paths are passed via a context variable so that the
tool functions (whose signatures are fixed by the LLM schema) do not
need an extra parameter.
"""

from __future__ import annotations

import contextvars
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

# ------------------------------------------------------------------
# Context variable: per-agent allowed paths (injected by ReActAgent)
# ------------------------------------------------------------------
_agent_allowed_paths_var: contextvars.ContextVar[list[str]] = contextvars.ContextVar(
    "agent_allowed_paths", default=[]
)


def set_agent_allowed_paths(paths: list[str]) -> None:
    """Set the allowed-path list for the current execution context."""
    _agent_allowed_paths_var.set(paths)


def get_agent_allowed_paths() -> list[str]:
    """Get the allowed-path list for the current execution context."""
    return _agent_allowed_paths_var.get()


# ------------------------------------------------------------------
# Hard-coded blacklist: NEVER allowed, regardless of mode or user config
# ------------------------------------------------------------------
_FORBIDDEN_PREFIXES = [
    # Linux/Unix system paths
    "/etc",
    "/usr",
    "/bin",
    "/sbin",
    "/lib",
    "/lib64",
    "/boot",
    "/sys",
    "/dev",
    "/proc",
    "/root",
    # macOS
    "/System",
    "/private/var/db",
    # Windows
    "C:\\Windows",
    "C:\\Program Files",
    "C:\\Program Files (x86)",
    "C:\\Windows\\System32",
]

_SENSITIVE_NAMES = {
    # SSH / GPG / crypto
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
    "known_hosts",
    "authorized_keys",
    "config",  # only dangerous inside .ssh – checked via parent below
    # Shell history
    ".bash_history",
    ".zsh_history",
    ".fish_history",
    # Windows SAM / registry hives
    "sam",
    "security",
    "system",
    "software",
    "ntds.dit",
    # Unix password files
    "passwd",
    "shadow",
    "master.passwd",
    "group",
    "gshadow",
    # Cloud credentials
    "credentials",
    "secrets",
    # Common env files with secrets
    ".env",
    ".env.local",
    ".env.production",
}

_SENSITIVE_PARENTS = {
    ".ssh",
    ".gnupg",
    ".aws",
    ".kube",
    ".docker",
    "ssh",
}

# ------------------------------------------------------------------
# Default whitelist bases
# ------------------------------------------------------------------
try:
    from app.database import WORKSPACE_ROOT, DATA_DIR  # type: ignore[import-not-found]
except ImportError:
    DATA_DIR = Path.home() / ".cloudmind-zome"
    WORKSPACE_ROOT = (
        Path(__file__).resolve().parent.parent.parent.parent.parent / "workspace"
    )

_PROJECT_ROOT = (
    Path(__file__).resolve().parent.parent.parent.parent.parent
)

_DEFAULT_READ_BASES: list[Path] = [
    DATA_DIR,
    WORKSPACE_ROOT,
    _PROJECT_ROOT,  # Allow agents to read their own source code
]

_DEFAULT_WRITE_BASES: list[Path] = [
    DATA_DIR,
    WORKSPACE_ROOT,
]


# ------------------------------------------------------------------
# Internal helpers
# ------------------------------------------------------------------
def _resolve(path: str) -> Path:
    """Expand ~ and resolve to absolute (follows symlinks)."""
    return Path(path).expanduser().resolve()


def _is_blacklisted(path: Path) -> tuple[bool, str]:
    """Check hard-coded blacklist."""
    try:
        resolved = path.resolve()
    except Exception as exc:
        return True, f"cannot resolve path: {exc}"

    # Prefix match
    for prefix in _FORBIDDEN_PREFIXES:
        prefix_path = Path(prefix).expanduser().resolve()
        try:
            resolved.relative_to(prefix_path)
            return True, f"access to {prefix} is forbidden"
        except ValueError:
            pass

    # Sensitive file name (exact match)
    name_lower = resolved.name.lower()
    if name_lower in _SENSITIVE_NAMES:
        return True, f"access to sensitive file '{resolved.name}' is forbidden"

    # Sensitive parent directory
    for parent in resolved.parents:
        if parent.name.lower() in _SENSITIVE_PARENTS:
            return True, f"access under sensitive directory '{parent.name}' is forbidden"

    return False, ""


def _is_under_any(path: Path, bases: list[Path]) -> bool:
    for base in bases:
        try:
            path.relative_to(base.resolve())
            return True
        except ValueError:
            pass
    return False


def _build_bases(
    mode: str,
    agent_paths: list[str] | None,
) -> list[Path]:
    """Build the effective whitelist for the given mode."""
    if mode == "read":
        bases = list(_DEFAULT_READ_BASES)
    else:
        bases = list(_DEFAULT_WRITE_BASES)

    extra = agent_paths if agent_paths is not None else get_agent_allowed_paths()
    for p in extra:
        if not p or not isinstance(p, str):
            continue
        try:
            resolved = Path(p).expanduser().resolve()
            # Safety: user-configured path must not itself be blacklisted
            blocked, reason = _is_blacklisted(resolved)
            if blocked:
                logger.warning(
                    "Agent allowed_path %r is blacklisted and ignored: %s",
                    p,
                    reason,
                )
                continue
            bases.append(resolved)
        except Exception as exc:
            logger.warning("Invalid agent_allowed_path %r: %s", p, exc)

    return bases


# ------------------------------------------------------------------
# Public API
# ------------------------------------------------------------------
def is_safe_path(
    path: str,
    mode: str = "read",
    agent_allowed_paths: list[str] | None = None,
) -> tuple[bool, str]:
    """Check whether *path* may be accessed in the given *mode*.

    Args:
        path: File path (may contain ~, relative components, etc.).
        mode: One of "read", "write", "delete", "share".
        agent_allowed_paths: Extra directories allowed for this agent.
            If None, falls back to the context variable (injected by
            ReActAgent before tool execution).

    Returns:
        (ok, reason)  — reason is empty when ok is True.
    """
    try:
        dest = _resolve(path)
    except Exception as exc:
        return False, f"invalid path: {exc}"

    # Layer 1: blacklist
    blocked, reason = _is_blacklisted(dest)
    if blocked:
        return False, reason

    # Layer 2: whitelist
    bases = _build_bases(mode, agent_allowed_paths)
    if _is_under_any(dest, bases):
        return True, ""

    allowed_str = ", ".join(str(b) for b in bases)
    return (
        False,
        f"access outside allowed directories is not allowed (allowed: {allowed_str})",
    )
