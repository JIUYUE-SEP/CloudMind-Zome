"""File write tool: create or overwrite files safely."""

from __future__ import annotations

import logging
from pathlib import Path

from ...tool.registry import tool_registry

logger = logging.getLogger(__name__)

# Max file size to write (5 MB)
MAX_SIZE = 5 * 1024 * 1024

# Critical paths that must never be written to
FORBIDDEN_PREFIXES = [
    "/etc", "/usr", "/bin", "/sbin", "/lib", "/lib64",
    "/boot", "/sys", "/dev", "/proc", "/root",
    "C:\\Windows", "C:\\Program Files", "C:\\Program Files (x86)",
]


def _is_safe_path(path: Path) -> tuple[bool, str]:
    """Check if writing to this path is safe."""
    try:
        resolved = path.resolve()
    except Exception as exc:
        return False, f"cannot resolve path: {exc}"

    # Prevent overwriting critical system paths
    for prefix in FORBIDDEN_PREFIXES:
        try:
            resolved.relative_to(Path(prefix))
            return False, f"writing to {prefix} is not allowed"
        except ValueError:
            pass

    return True, ""


@tool_registry.register(toolset="file", max_result_chars=2000, safe_to_parallel=False)
def write_file(path: str, content: str) -> str:
    """Create or overwrite a file with the given content.

    The parent directories will be created automatically if they don't exist.
    Maximum file size: 5 MB.

    Args:
        path: Absolute or relative path of the file to write.
        content: The text content to write into the file.
    """
    dest = Path(path).expanduser()

    ok, reason = _is_safe_path(dest)
    if not ok:
        return f"Error: {reason}"

    if len(content) > MAX_SIZE:
        return f"Error: content too large ({len(content)} bytes, max {MAX_SIZE})"

    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(content, encoding="utf-8")
        size = len(content.encode("utf-8"))
        return f"File written: {dest} ({size} bytes)"
    except PermissionError:
        return f"Error: permission denied for {dest}"
    except OSError as exc:
        logger.exception("write_file failed for %s", dest)
        return f"Error: {exc}"
