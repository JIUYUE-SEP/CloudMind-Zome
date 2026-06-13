"""File write tool: create or overwrite files safely."""

from __future__ import annotations

import logging
from pathlib import Path

from ...tool.registry import tool_registry
from .security import is_safe_path

logger = logging.getLogger(__name__)

# Max file size to write (5 MB)
MAX_SIZE = 5 * 1024 * 1024


@tool_registry.register(toolset="file", max_result_chars=2000, safe_to_parallel=False)
def write_file(path: str, content: str) -> str:
    """Create a new file or overwrite an existing file with the given content.

    The parent directories will be created automatically if they don't exist.
    Maximum file size: 5 MB.

    IMPORTANT: If the file already exists, this tool will return a warning.
    In that case, you MUST read the file first with read_file, then use
    edit_file to make targeted changes. Only overwrite the entire file when
    the user explicitly asks you to do so.

    Args:
        path: Absolute or relative path of the file to write.
        content: The text content to write into the file.
    """
    dest = Path(path).expanduser()

    ok, reason = is_safe_path(path, mode="write")
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
