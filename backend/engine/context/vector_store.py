"""Zvec vector store for semantic memory search.

Replaces ChromaDB with Alibaba's zvec (C++ backend, Python bindings).
Single collection for all agents, filtered by agent_id.
Embedding dimension is inferred lazily on first add().
"""

from __future__ import annotations

import logging
import shutil
from pathlib import Path
from typing import Any

import zvec

logger = logging.getLogger(__name__)

_ZVEC_DIR = Path.home() / ".cloudmind-zome" / "zvec"

# Default HNSW parameters (tuned for ~1K-100K docs per desktop deployment)
_HNSW_M = 16
_HNSW_EF_CONSTRUCTION = 200


def _check_schema_has_field(coll: zvec.Collection, field_name: str) -> bool:
    """Check if collection schema has a given field."""
    try:
        field_names = {f.name for f in coll.schema.fields}
        return field_name in field_names
    except Exception:
        return False


class AgentMemoryStore:
    """Semantic memory backed by zvec.

    One collection holds all agents' memories.
    ``agent_id`` is a scalar field used for filtering.
    Embedding dimension is determined lazily on first ``add()`` call.
    """

    def __init__(self) -> None:
        _ZVEC_DIR.mkdir(parents=True, exist_ok=True)
        self._path = _ZVEC_DIR / "agent_memory"
        self._coll: zvec.Collection | None = None
        self._dim: int | None = None
        # Topic summaries collection
        self._topics_path = _ZVEC_DIR / "agent_topics"
        self._topics_coll: zvec.Collection | None = None

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _ensure_collection(self, dim: int | None = None) -> zvec.Collection:
        """Open existing collection or create new one with inferred dim."""
        if self._coll is not None:
            return self._coll

        if self._path.exists():
            # Open existing and read dimension from schema
            self._coll = zvec.open(str(self._path))
            if not _check_schema_has_field(self._coll, "source_id") or not _check_schema_has_field(self._coll, "timestamp"):
                logger.warning(
                    "Old zvec agent_memory schema detected (missing source_id or timestamp), rebuilding..."
                )
                self._coll = None
                shutil.rmtree(str(self._path), ignore_errors=True)
            else:
                vec_schema = self._coll.schema.vectors
                # vectors may be a single VectorSchema or a list
                if isinstance(vec_schema, list):
                    self._dim = vec_schema[0].dimension
                else:
                    self._dim = vec_schema.dimension
                logger.info(
                    "Opened existing zvec collection at %s (dim=%s)", self._path, self._dim
                )
                return self._coll

        # Create new collection — need dimension
        target_dim = dim
        if target_dim is None:
            raise ValueError(
                "Cannot create zvec collection: embedding dimension unknown. "
                "Pass an embedding on the first add() call."
            )

        schema = zvec.CollectionSchema(
            name="agent_memory",
            fields=[
                zvec.FieldSchema("message_id", zvec.DataType.STRING),
                zvec.FieldSchema("agent_id", zvec.DataType.STRING),
                zvec.FieldSchema("text", zvec.DataType.STRING),
                zvec.FieldSchema("role", zvec.DataType.STRING),
                zvec.FieldSchema("source", zvec.DataType.STRING),
                zvec.FieldSchema("source_id", zvec.DataType.STRING),
                zvec.FieldSchema("source_name", zvec.DataType.STRING),
                zvec.FieldSchema("timestamp", zvec.DataType.FLOAT),
            ],
            vectors=zvec.VectorSchema(
                "embedding",
                zvec.DataType.VECTOR_FP32,
                dimension=target_dim,
                index_param=zvec.HnswIndexParam(
                    m=_HNSW_M, ef_construction=_HNSW_EF_CONSTRUCTION
                ),
            ),
        )
        self._coll = zvec.create_and_open(str(self._path), schema)
        self._dim = target_dim
        logger.info("Created zvec collection at %s (dim=%s)", self._path, self._dim)
        return self._coll

    @staticmethod
    def _doc_id(agent_id: str, message_id: str) -> str:
        """Globally unique doc id: agent_id:message_id."""
        return f"{agent_id}:{message_id}"

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def add(
        self,
        agent_id: str,
        message_id: str,
        text: str,
        embedding: list[float],
        metadata: dict[str, str] | None = None,
        timestamp: float = 0.0,
    ) -> None:
        """Add a message embedding to the shared collection."""
        try:
            dim = len(embedding)
            coll = self._ensure_collection(dim=dim)

            meta = metadata or {}
            coll.insert([
                zvec.Doc(
                    id=self._doc_id(agent_id, message_id),
                    vectors={"embedding": embedding},
                    fields={
                        "message_id": message_id,
                        "agent_id": agent_id,
                        "text": text[:2000],
                        "role": meta.get("role", ""),
                        "source": meta.get("source", ""),
                        "source_id": meta.get("source_id", ""),
                        "source_name": meta.get("source_name", ""),
                        "timestamp": float(timestamp),
                    },
                )
            ])
        except Exception as exc:
            logger.warning("zvec add failed for agent %s: %s", agent_id, exc)

    def search(
        self,
        agent_id: str,
        query_embedding: list[float],
        top_k: int = 5,
        where: str | None = None,
    ) -> list[dict[str, Any]]:
        """Search the agent's memory by vector similarity.

        Args:
            where: Optional zvec filter string, e.g. ``role == 'user'``.

        Returns list of {message_id, text, score, metadata}.
        """
        try:
            coll = self._ensure_collection()

            # Build filter expression
            filter_parts = [f'agent_id == "{agent_id}"']
            if where:
                filter_parts.append(where)
            filter_expr = " AND ".join(filter_parts)

            results = coll.query(
                vectors=zvec.VectorQuery(
                    field_name="embedding", vector=query_embedding
                ),
                topk=top_k,
                filter=filter_expr,
            )

            items: list[dict[str, Any]] = []
            for doc in results:
                items.append({
                    "message_id": doc.field("message_id"),
                    "text": doc.field("text"),
                    "score": doc.score,
                    "timestamp": doc.field("timestamp"),
                    "metadata": {
                        "role": doc.field("role"),
                        "source": doc.field("source"),
                        "source_id": doc.field("source_id"),
                        "source_name": doc.field("source_name"),
                    },
                })
            return items
        except Exception as exc:
            logger.warning("zvec search failed for agent %s: %s", agent_id, exc)
            return []

    def delete_by_filter(
        self,
        agent_id: str,
        where: str | None = None,
    ) -> int:
        """Delete documents matching agent_id + optional extra filter.

        Returns number of deleted documents (estimated).
        """
        try:
            coll = self._ensure_collection()

            filter_parts = [f'agent_id == "{agent_id}"']
            if where:
                filter_parts.append(where)
            filter_expr = " AND ".join(filter_parts)

            # zvec delete_by_filter does not return count.
            # Peek first to estimate.
            peek = coll.query(
                vectors=zvec.VectorQuery(field_name="embedding", vector=[0.0] * self._dim),
                topk=99999,
                filter=filter_expr,
            )
            count = len(peek)
            if count:
                coll.delete_by_filter(filter_expr)
            return count
        except Exception as exc:
            logger.warning("zvec delete_by_filter failed for agent %s: %s", agent_id, exc)
            return 0

    def delete_agent(self, agent_id: str) -> None:
        """Drop all memory docs for an agent."""
        try:
            coll = self._ensure_collection()
            coll.delete_by_filter(f'agent_id == "{agent_id}"')
        except Exception:
            pass

    # ------------------------------------------------------------------
    # Topic summaries
    # ------------------------------------------------------------------

    def _ensure_topics_collection(self, dim: int | None = None) -> zvec.Collection:
        """Open or create the agent_topics collection."""
        if self._topics_coll is not None:
            return self._topics_coll

        if self._topics_path.exists():
            self._topics_coll = zvec.open(str(self._topics_path))
            if not _check_schema_has_field(self._topics_coll, "source_id"):
                logger.warning(
                    "Old zvec agent_topics schema detected (missing source_id), rebuilding..."
                )
                self._topics_coll = None
                shutil.rmtree(str(self._topics_path), ignore_errors=True)
            else:
                vec_schema = self._topics_coll.schema.vectors
                if isinstance(vec_schema, list):
                    self._dim = vec_schema[0].dimension
                else:
                    self._dim = vec_schema.dimension
                return self._topics_coll

        target_dim = dim
        if target_dim is None:
            raise ValueError(
                "Cannot create zvec topics collection: embedding dimension unknown."
            )

        schema = zvec.CollectionSchema(
            name="agent_topics",
            fields=[
                zvec.FieldSchema("agent_id", zvec.DataType.STRING),
                zvec.FieldSchema("topic_id", zvec.DataType.STRING),
                zvec.FieldSchema("subtopic", zvec.DataType.STRING),
                zvec.FieldSchema("summary_text", zvec.DataType.STRING),
                zvec.FieldSchema("importance", zvec.DataType.STRING),
                zvec.FieldSchema("source_id", zvec.DataType.STRING),
            ],
            vectors=zvec.VectorSchema(
                "embedding",
                zvec.DataType.VECTOR_FP32,
                dimension=target_dim,
                index_param=zvec.HnswIndexParam(
                    m=_HNSW_M, ef_construction=_HNSW_EF_CONSTRUCTION
                ),
            ),
        )
        self._topics_coll = zvec.create_and_open(str(self._topics_path), schema)
        self._dim = target_dim
        logger.info("Created zvec topics collection at %s (dim=%s)", self._topics_path, self._dim)
        return self._topics_coll

    def add_topic(
        self,
        agent_id: str,
        topic_id: str,
        subtopic: str,
        summary: str,
        importance: str,
        embedding: list[float],
        source_id: str = "",
    ) -> None:
        """Add a topic summary to vector store."""
        try:
            dim = len(embedding)
            coll = self._ensure_topics_collection(dim=dim)
            doc_id = f"{agent_id}:{topic_id}:{subtopic}"
            coll.insert([
                zvec.Doc(
                    id=doc_id,
                    vectors={"embedding": embedding},
                    fields={
                        "agent_id": agent_id,
                        "topic_id": topic_id,
                        "subtopic": subtopic,
                        "summary_text": summary[:2000],
                        "importance": importance,
                        "source_id": source_id,
                    },
                )
            ])
        except Exception as exc:
            logger.warning("zvec add_topic failed for agent %s: %s", agent_id, exc)

    def search_topics(
        self, agent_id: str, embedding: list[float], topk: int = 3, where: str | None = None
    ) -> list[dict[str, Any]]:
        """Semantic search for related topics."""
        try:
            coll = self._ensure_topics_collection()

            filter_parts = [f'agent_id == "{agent_id}"']
            if where:
                filter_parts.append(where)
            filter_expr = " AND ".join(filter_parts)

            results = coll.query(
                vectors=zvec.VectorQuery(field_name="embedding", vector=embedding),
                topk=topk,
                filter=filter_expr,
            )
            return [
                {
                    "topic_id": doc.field("topic_id"),
                    "subtopic": doc.field("subtopic"),
                    "summary": doc.field("summary_text"),
                    "score": doc.score,
                    "source_id": doc.field("source_id"),
                }
                for doc in results
            ]
        except Exception as exc:
            logger.warning("zvec search_topics failed for agent %s: %s", agent_id, exc)
            return []

    def delete_agent_topics(self, agent_id: str) -> None:
        """Delete all topic summaries for an agent."""
        try:
            coll = self._ensure_topics_collection()
            coll.delete_by_filter(f'agent_id == "{agent_id}"')
        except Exception:
            pass
