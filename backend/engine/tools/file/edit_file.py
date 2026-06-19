"""File edit tool: modify existing files safely."""

from __future__ import annotations

import logging
from pathlib import Path
from pydantic import BaseModel, Field

from ...tool.registry import tool_registry
from .security import is_safe_path

logger = logging.getLogger(__name__)

# Max file size (5 MB)
MAX_SIZE = 5 * 1024 * 1024


class EditFileInput(BaseModel):
    """Validated input for edit_file."""
    path: str = Field(..., min_length=1, description="Absolute or relative path of the file to edit.")
    old_text: str = Field(..., description="Exact text segment to replace.")
    new_text: str = Field(..., description="Replacement text.")


@tool_registry.register(
    toolset="file",
    max_result_chars=3000,
    safe_to_parallel=False,
    input_schema=EditFileInput,
    permission="file:edit",
)
def edit_file(path: str, old_text: str, new_text: str) -> str:
    """Edit an existing file by replacing a specific text segment.

    This is the recommended way to modify files. Read the file first with
    read_file, then call edit_file with the exact old_text you want to replace.
    If old_text is empty, new_text will be appended to the end of the file.

    Args:
        path: Absolute or relative path of the file to edit.
        old_text: The exact text segment to replace. Must match exactly
                  (including whitespace and newlines). If empty, appends.
        new_text: The replacement text.

    Returns:
        Success message with line count, or error description.
    """
    dest = Path(path).expanduser()

    ok, reason = is_safe_path(path, mode="write")
    if not ok:
        return f"Error: {reason}"

    if not dest.exists():
        return f"Error: file does not exist: {dest}"

    if not dest.is_file():
        return f"Error: {dest} is not a file"

    try:
        original = dest.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return "Error: file is not text-readable (binary file?)"
    except OSError as exc:
        return f"Error: cannot read file: {exc}"

    if len(original) > MAX_SIZE:
        return f"Error: file too large ({len(original)} bytes, max {MAX_SIZE})"

    # Append mode
    if old_text == "":
        modified = original + new_text
        if not original.endswith("\n") and new_text:
            modified = original + "\n" + new_text
    else:
        # Exact replacement
        if old_text not in original:
            # Show a small context hint for debugging
            snippet = original[:200].replace("\n", "\\n")
            return (
                f"Error: old_text not found in file.\n"
                f"File starts with: {snippet!r}\n"
                f"Make sure old_text matches exactly (including whitespace)."
            )

        # Prevent ambiguous replacements (multiple matches)
        count = original.count(old_text)
        if count > 1:
            lines = original.splitlines()
            matches = []
            for i, line in enumerate(lines, 1):
                if old_text in line:
                    matches.append(str(i))
                    if len(matches) >= 5:
                        matches.append("...")
                        break
            return (
                f"Error: old_text appears {count} times in file.\n"
                f"Found on line(s): {', '.join(matches)}.\n"
                f"Please include more surrounding context to make old_text unique."
            )

        modified = original.replace(old_text, new_text, 1)

    # Validate result size
    if len(modified) > MAX_SIZE:
        return f"Error: result too large ({len(modified)} bytes, max {MAX_SIZE})"

    try:
        dest.write_text(modified, encoding="utf-8")
    except OSError as exc:
        logger.exception("edit_file failed for %s", dest)
        return f"Error: cannot write file: {exc}"

    original_lines = original.count("\n")
    modified_lines = modified.count("\n")
    delta = modified_lines - original_lines

    return (
        f"File edited: {dest}\n"
        f"  Original: {len(original)} bytes, {original_lines} lines\n"
        f"  Modified: {len(modified)} bytes, {modified_lines} lines\n"
        f"  Delta: {delta:+d} lines"
    )
