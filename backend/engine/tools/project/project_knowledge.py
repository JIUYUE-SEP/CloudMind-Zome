"""Project knowledge tools: let the Agent read and search project docs."""

from __future__ import annotations

import logging
from pathlib import Path

from ...tool.registry import tool_registry

logger = logging.getLogger(__name__)

DOCS_DIR = Path(__file__).parent.parent.parent / "docs"

# One-line summaries for each doc
_DOC_SUMMARIES = {
    "agent-architecture.md": "Overall project architecture, directory structure, core concepts",
    "tool-guide.md": "How to add, register, and modify tools",
    "api-guide.md": "REST and WebSocket API routes, data models",
}


def _list_doc_files() -> list[Path]:
    if not DOCS_DIR.exists():
        return []
    return sorted(f for f in DOCS_DIR.iterdir() if f.suffix == ".md")


@tool_registry.register(toolset="project", max_result_chars=2000, safe_to_parallel=True)
def list_project_docs() -> str:
    """List all available project documentation files.

    Documents are stored in engine/docs/.
    Returns a numbered list of document names with one-line descriptions.
    After getting the list, you MUST immediately call read_file with path
    "engine/docs/{filename}" to read the most relevant document.
    Do not stop after listing; always read the full content of the relevant doc.
    """
    files = _list_doc_files()
    if not files:
        return "No project documentation found."

    lines = ["Available project documents:"]
    for i, f in enumerate(files, 1):
        summary = _DOC_SUMMARIES.get(f.name, "Project documentation")
        lines.append(f"{i}. {f.name} - {summary}")
    lines.append('\nUse read_file("engine/docs/{filename}") to read the full content of any document.')
    return "\n".join(lines)


@tool_registry.register(toolset="project", max_result_chars=4000, safe_to_parallel=True)
def search_project_docs(query: str) -> str:
    """Search project documentation for a keyword or phrase.

    Documents are stored in engine/docs/.
    Returns matching document names + the surrounding context lines.
    After searching, you MUST immediately call read_file with path
    "engine/docs/{filename}" to read the most relevant document.
    Do not stop after searching; always read the full content of the relevant doc.

    Args:
        query: Keyword or phrase to search for (case-insensitive).
    """
    if not query or not query.strip():
        return "Error: query cannot be empty"

    query_lower = query.lower().strip()
    files = _list_doc_files()
    if not files:
        return "No project documentation found."

    results: list[str] = []
    for f in files:
        try:
            text = f.read_text(encoding="utf-8")
        except Exception as exc:
            logger.warning("Cannot read %s: %s", f, exc)
            continue

        lines = text.splitlines()
        matches: list[tuple[int, str]] = []
        for idx, line in enumerate(lines, 1):
            if query_lower in line.lower():
                matches.append((idx, line.strip()))

        if not matches:
            continue

        results.append(f"--- {f.name} ({len(matches)} matches) ---")
        for line_no, line_text in matches[:8]:  # cap at 8 matches per file
            # Show 2 lines of context before and after
            start = max(0, line_no - 3)
            end = min(len(lines), line_no + 2)
            context = lines[start:end]
            for ctx_idx, ctx_line in enumerate(context, start + 1):
                marker = " >>>" if ctx_idx == line_no else "    "
                results.append(f"{marker} L{ctx_idx}: {ctx_line}")
            results.append("")

    if not results:
        return f'No matches found for "{query}". Try broader keywords or list_project_docs to see available docs.'

    header = f'Search results for "{query}":\n'
    return header + "\n".join(results)
