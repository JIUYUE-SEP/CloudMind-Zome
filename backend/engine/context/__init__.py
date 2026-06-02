"""Context management.

- ContextPipeline: assembles LLM prompt with scene-isolated hot context,
  cross-scene semantic retrieval, and tiered token downgrade.
"""

from .context_pipeline import ContextPipeline

__all__ = ["ContextPipeline"]
