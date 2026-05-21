"""File tools: safe delete (move to system trash / recycle bin).

Uses send2trash to move files to the platform-native trash:
- Windows: Recycle Bin
- macOS: Trash
- Linux: freedesktop.org Trash
"""

from __future__ import annotations

import logging
from pathlib import Path

from send2trash import send2trash

from ...tool.registry import tool_registry

logger = logging.getLogger(__name__)


def _is_safe_to_delete(path: Path) -> tuple[bool, str]:
    """Basic safety check before moving a file to system trash."""
    if not path.exists():
        return False, "file does not exist"

    if path.is_dir():
        return False, "cannot delete directories (only files)"

    # Resolve to real path to avoid symlink tricks
    try:
        resolved = path.resolve()
    except Exception as exc:
        return False, f"cannot resolve path: {exc}"

    # Prevent deleting system-critical paths
    critical_prefixes = {
        Path("/"),
        Path("/etc"),
        Path("/usr"),
        Path("/bin"),
        Path("/sbin"),
        Path("/lib"),
        Path("/lib64"),
        Path("/boot"),
        Path("/sys"),
        Path("/dev"),
        Path("/proc"),
    }
    for prefix in critical_prefixes:
        try:
            resolved.relative_to(prefix)
            return False, f"deleting files under {prefix} is not allowed"
        except ValueError:
            pass

    return True, ""


@tool_registry.register(toolset="file", max_result_chars=4000, safe_to_parallel=False)
def delete_file(path: str) -> str:
    """Delete a file by moving it to the system trash / recycle bin.

    On Windows the file goes to the Recycle Bin.
    On macOS the file goes to Trash.
    On Linux the file follows the freedesktop.org Trash specification.

    Args:
        path: Absolute or relative path of the file to delete.
    """
    src = Path(path).expanduser()
    ok, reason = _is_safe_to_delete(src)
    if not ok:
        return f"Error: {reason}"

    try:
        send2trash(str(src))
        return f"File moved to system trash: {src.name}"
    except Exception as exc:
        logger.exception("delete_file failed for %s", src)
        return f"Error: failed to move file to trash: {exc}"
