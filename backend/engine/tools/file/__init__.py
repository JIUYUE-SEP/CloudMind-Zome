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
from .security import is_safe_path

logger = logging.getLogger(__name__)


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

    ok, reason = is_safe_path(path, mode="delete")
    if not ok:
        return f"Error: {reason}"

    if not src.exists():
        return f"Error: file does not exist: {src}"

    if src.is_dir():
        return f"Error: cannot delete directories (only files): {src}"

    try:
        send2trash(str(src))
        return f"File moved to system trash: {src.name}"
    except Exception as exc:
        logger.exception("delete_file failed for %s", src)
        return f"Error: failed to move file to trash: {exc}"
