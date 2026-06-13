"""Token counter with tiktoken + fallback heuristic."""
from __future__ import annotations

import logging
from functools import lru_cache

logger = logging.getLogger(__name__)


@lru_cache(maxsize=32)
def _get_encoding(model: str):
    import tiktoken

    # Map common aliases to tiktoken-known model names
    model_lower = model.lower()
    if "gpt-4" in model_lower:
        return tiktoken.encoding_for_model("gpt-4")
    if "gpt-3.5" in model_lower or "gpt-35" in model_lower:
        return tiktoken.encoding_for_model("gpt-3.5-turbo")
    if "claude" in model_lower:
        # tiktoken doesn't support Claude; fallback will be used
        return None
    if "qwen" in model_lower or "deepseek" in model_lower or "glm" in model_lower:
        # Try cl100k_base as a reasonable approximation
        try:
            return tiktoken.get_encoding("cl100k_base")
        except Exception:
            return None
    try:
        return tiktoken.encoding_for_model(model)
    except Exception:
        return None


def count_tokens(text: str, model: str = "gpt-4") -> int:
    """Return approximate token count for *text* under *model*.

    Uses tiktoken when available; falls back to ``len(text.encode("utf-8")) // 4``
    (the QwenPaw heuristic) for unsupported models.
    """
    if not text:
        return 0
    enc = _get_encoding(model)
    if enc is not None:
        try:
            return len(enc.encode(text))
        except Exception as exc:
            logger.debug("tiktoken encode failed for %s: %s", model, exc)
    # Fallback heuristic
    return max(1, len(text.encode("utf-8")) // 4)
