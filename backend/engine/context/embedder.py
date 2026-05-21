"""Embedding client: calls OpenAI-compatible embedding API.

Design: fully independent from Agent provider config.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from ..config.models import EmbeddingModelConfig

logger = logging.getLogger(__name__)


class Embedder:
    """Lightweight async embedder."""

    def __init__(self, cfg: EmbeddingModelConfig):
        self.cfg = cfg
        self._client: httpx.AsyncClient | None = None

    def _get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=30.0)
        return self._client

    async def embed(self, texts: list[str]) -> list[list[float]]:
        """Return embeddings for a batch of texts.

        Returns empty list if not configured.
        """
        if not self.cfg.base_url or not self.cfg.model or not self.cfg.api_key:
            return []

        if not texts:
            return []

        client = self._get_client()
        try:
            resp = await client.post(
                f"{self.cfg.base_url.rstrip('/')}/embeddings",
                headers={
                    "Authorization": f"Bearer {self.cfg.api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": self.cfg.model,
                    "input": texts,
                },
            )
            resp.raise_for_status()
            data = resp.json()
            embeddings = [item["embedding"] for item in data["data"]]
            return embeddings
        except Exception as exc:
            logger.warning("Embedding request failed: %s", exc)
            return []

    async def embed_single(self, text: str) -> list[float]:
        """Embed a single text."""
        results = await self.embed([text])
        return results[0] if results else []

    async def close(self) -> None:
        if self._client:
            await self._client.aclose()
            self._client = None
