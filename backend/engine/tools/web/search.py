"""Web search tool — Tavily Search API.

Requires a Tavily API key from https://tavily.com.
Set it via environment variable TAVILY_API_KEY or engine/config.yaml.
"""

from __future__ import annotations

import logging
import os
from typing import Any

import httpx

from engine.config.loader import load_config
from engine.tool.registry import tool_registry

logger = logging.getLogger(__name__)

_TAVILY_ENDPOINT = "https://api.tavily.com/search"


def _get_api_key() -> str | None:
    """Resolve Tavily API key from env or engine config."""
    key = os.environ.get("TAVILY_API_KEY", "")
    if key:
        return key

    try:
        import pathlib
        cfg_path = pathlib.Path(__file__).resolve().parent.parent.parent / "config.yaml"
        cfg = load_config(cfg_path)
        tavily_cfg = getattr(cfg, "tavily", None)
        if isinstance(tavily_cfg, dict):
            return tavily_cfg.get("api_key", "") or ""
    except Exception:
        pass

    return None


def _format_results(data: dict[str, Any], query: str, max_results: int) -> str:
    """Format Tavily API response into a concise text."""
    lines: list[str] = [f"Web search results for: {query}", ""]

    results = data.get("results", [])
    if not results:
        lines.append("No web results found.")
        return "\n".join(lines)

    for i, r in enumerate(results[:max_results], 1):
        title = r.get("title", "Untitled")
        url = r.get("url", "")
        content = r.get("content", "").replace("\n", " ")
        lines.append(f"{i}. {title}")
        lines.append(f"   URL: {url}")
        if content:
            lines.append(f"   {content}")
        lines.append("")

    return "\n".join(lines)


@tool_registry.register(toolset="web", max_result_chars=8000, safe_to_parallel=True, timeout=30)
async def search_web(query: str, max_results: int = 5) -> str:
    """Search the web using Tavily Search API.

    Returns a list of search results with title, URL and content summary.

    Args:
        query: Search query string.
        max_results: Number of results to return (1-10, default 5).
    """
    api_key = _get_api_key()
    if not api_key:
        return (
            "Error: Tavily API key is not configured.\n\n"
            "To enable web search:\n"
            "1. Go to https://tavily.com → Sign up for free\n"
            "2. Copy your API key from the dashboard\n"
            "3. Set environment variable: TAVILY_API_KEY=your_key\n"
            "   Or add to backend/engine/config.yaml under 'tavily: api_key: your_key'"
        )

    count = max(1, min(max_results, 10))

    payload = {
        "api_key": api_key,
        "query": query,
        "search_depth": "basic",
        "max_results": count,
        "include_answer": False,
    }

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(_TAVILY_ENDPOINT, json=payload)
            response.raise_for_status()
            data = response.json()
            return _format_results(data, query, count)
    except httpx.HTTPStatusError as exc:
        logger.error("Tavily API HTTP error: %s", exc.response.text)
        return f"Error: Tavily API returned {exc.response.status_code}. Please check your API key."
    except httpx.TimeoutException:
        return "Error: Tavily search timed out."
    except Exception as exc:
        logger.exception("search_web failed")
        return f"Error: search failed: {exc}"
