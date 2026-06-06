"""Embedding client: calls OpenAI-compatible embedding API.

Design: fully independent from Agent provider config.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

logger = logging.getLogger(__name__)


class Embedder:
    """Lightweight async embedder.

    Args:
        base_url: Provider base URL (e.g. https://api.siliconflow.cn/v1).
        api_key: Provider API key.
        model: Model name for the embedding endpoint.
    """

    def __init__(self, base_url: str, api_key: str, model: str):
        self.base_url = base_url
        self.api_key = api_key
        self.model = model
        self._client: httpx.AsyncClient | None = None

    def _get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=30.0)
        return self._client

    async def embed(self, texts: list[str]) -> list[list[float]]:
        """Return embeddings for a batch of texts.

        Returns empty list if not configured.
        """
        if not self.base_url or not self.model or not self.api_key:
            return []

        if not texts:
            return []

        # Build endpoint: handle "https://host", "https://host/v1", or full path
        base = self.base_url.rstrip('/')
        if base.endswith('/embeddings'):
            endpoint = base
        elif base.endswith('/v1'):
            endpoint = f"{base}/embeddings"
        else:
            endpoint = f"{base}/v1/embeddings"

        client = self._get_client()
        try:
            resp = await client.post(
                endpoint,
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": self.model,
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
