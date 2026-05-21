"""ChromaDB vector store for semantic memory search.

One collection per agent, persistent on disk.
"""

from __future__ import annotations

import logging
from pathlib import Path

import chromadb
from chromadb.api.types import EmbeddingFunction

logger = logging.getLogger(__name__)

_CHROMA_DIR = Path.home() / ".cloudmind-zome" / "vectors"


class AgentMemoryStore:
    """Semantic memory backed by ChromaDB.

    Each agent gets its own collection.
    Documents are message UUIDs; metadata stores role/source for display.
    """

    def __init__(self) -> None:
        _CHROMA_DIR.mkdir(parents=True, exist_ok=True)
        self._client = chromadb.PersistentClient(path=str(_CHROMA_DIR))

    def _collection_name(self, agent_id: str) -> str:
        # Chroma collection names must be 3-63 chars, alphanumeric + underscore + hyphen
        safe = "".join(c if c.isalnum() else "_" for c in agent_id)
        return f"agent_{safe}"

    def add(
        self,
        agent_id: str,
        message_id: str,
        text: str,
        embedding: list[float],
        metadata: dict[str, str] | None = None,
    ) -> None:
        """Add a message embedding to the agent's collection."""
        try:
            coll = self._client.get_or_create_collection(
                name=self._collection_name(agent_id),
                metadata={"hnsw:space": "cosine"},
            )
            coll.add(
                ids=[message_id],
                embeddings=[embedding],
                documents=[text],
                metadatas=[metadata or {}],
            )
        except Exception as exc:
            # If dimension mismatch (user switched embedding model), drop and recreate
            err = str(exc).lower()
            if "dimension" in err or "shape" in err:
                logger.warning(
                    "Dimension mismatch for agent %s collection, dropping and recreating",
                    agent_id,
                )
                try:
                    self._client.delete_collection(name=self._collection_name(agent_id))
                except Exception:
                    pass
                try:
                    coll = self._client.create_collection(
                        name=self._collection_name(agent_id),
                        metadata={"hnsw:space": "cosine"},
                    )
                    coll.add(
                        ids=[message_id],
                        embeddings=[embedding],
                        documents=[text],
                        metadatas=[metadata or {}],
                    )
                except Exception as exc2:
                    logger.warning("Chroma re-add failed for agent %s: %s", agent_id, exc2)
            else:
                logger.warning("Chroma add failed for agent %s: %s", agent_id, exc)

    def search(
        self,
        agent_id: str,
        query_embedding: list[float],
        top_k: int = 5,
    ) -> list[dict[str, Any]]:
        """Search the agent's memory by vector similarity.

        Returns list of {message_id, text, distance, metadata}.
        """
        try:
            coll = self._client.get_or_create_collection(
                name=self._collection_name(agent_id),
                metadata={"hnsw:space": "cosine"},
            )
            results = coll.query(
                query_embeddings=[query_embedding],
                n_results=top_k,
                include=["documents", "metadatas", "distances"],
            )
            items = []
            for i, msg_id in enumerate(results["ids"][0]):
                items.append({
                    "message_id": msg_id,
                    "text": results["documents"][0][i],
                    "distance": results["distances"][0][i],
                    "metadata": results["metadatas"][0][i] if results["metadatas"] else {},
                })
            return items
        except Exception as exc:
            logger.warning("Chroma search failed for agent %s: %s", agent_id, exc)
            return []

    def delete_agent(self, agent_id: str) -> None:
        """Drop an agent's entire collection (e.g. on agent deletion)."""
        try:
            self._client.delete_collection(name=self._collection_name(agent_id))
        except Exception:
            pass
