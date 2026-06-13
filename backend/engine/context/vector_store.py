"""Zvec vector store for semantic memory search.

Replaces ChromaDB with Alibaba's zvec (C++ backend, Python bindings).
Per-agent collections so each Agent can use a different embedding dimension.
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

    One collection per agent so different agents can use different embedding dimensions.
    ``agent_id`` is a scalar field used for filtering within the collection as well.
    Embedding dimension is determined lazily on first ``add()`` call.
    """

    def __init__(self) -> None:
        _ZVEC_DIR.mkdir(parents=True, exist_ok=True)
        self._colls: dict[str, zvec.Collection] = {}
        self._topics_colls: dict[str, zvec.Collection] = {}
        self._dims: dict[str, int] = {}

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _ensure_collection(self, agent_id: str, dim: int | None = None) -> zvec.Collection:
        """Open existing collection or create new one with inferred dim."""
        if agent_id in self._colls:
            return self._colls[agent_id]

        path = _ZVEC_DIR / f"agent_memory_{agent_id}"
        if path.exists():
            coll = zvec.open(str(path))
            if not _check_schema_has_field(coll, "source_id") or not _check_schema_has_field(coll, "timestamp"):
                logger.warning(
                    "Old zvec agent_memory schema detected (missing source_id or timestamp), rebuilding..."
                )
                coll = None
                shutil.rmtree(str(path), ignore_errors=True)
            else:
                vec_schema = coll.schema.vectors
                if isinstance(vec_schema, list):
                    self._dims[agent_id] = vec_schema[0].dimension
                else:
                    self._dims[agent_id] = vec_schema.dimension
                logger.info(
                    "Opened existing zvec collection at %s (dim=%s)", path, self._dims[agent_id]
                )
                self._colls[agent_id] = coll
                return coll

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
        coll = zvec.create_and_open(str(path), schema)
        self._colls[agent_id] = coll
        self._dims[agent_id] = target_dim
        logger.info("Created zvec collection at %s (dim=%s)", path, target_dim)
        return coll

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
        """Add a message embedding to the agent's collection."""
        try:
            dim = len(embedding)
            coll = self._ensure_collection(agent_id, dim=dim)

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
            coll = self._ensure_collection(agent_id)

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
            coll = self._ensure_collection(agent_id)

            filter_parts = [f'agent_id == "{agent_id}"']
            if where:
                filter_parts.append(where)
            filter_expr = " AND ".join(filter_parts)

            # zvec delete_by_filter does not return count.
            # Peek first to estimate.
            peek = coll.query(
                vectors=zvec.VectorQuery(field_name="embedding", vector=[0.0] * self._dims[agent_id]),
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
            coll = self._ensure_collection(agent_id)
            coll.delete_by_filter(f'agent_id == "{agent_id}"')
        except Exception:
            pass

    # ------------------------------------------------------------------
    # Topic summaries
    # ------------------------------------------------------------------

    def _ensure_topics_collection(self, agent_id: str, dim: int | None = None) -> zvec.Collection:
        """Open or create the agent's topics collection."""
        if agent_id in self._topics_colls:
            return self._topics_colls[agent_id]

        path = _ZVEC_DIR / f"agent_topics_{agent_id}"
        if path.exists():
            coll = zvec.open(str(path))
            if not _check_schema_has_field(coll, "source_id"):
                logger.warning(
                    "Old zvec agent_topics schema detected (missing source_id), rebuilding..."
                )
                coll = None
                shutil.rmtree(str(path), ignore_errors=True)
            else:
                vec_schema = coll.schema.vectors
                if isinstance(vec_schema, list):
                    self._dims[agent_id] = vec_schema[0].dimension
                else:
                    self._dims[agent_id] = vec_schema.dimension
                self._topics_colls[agent_id] = coll
                return coll

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
        coll = zvec.create_and_open(str(path), schema)
        self._topics_colls[agent_id] = coll
        self._dims[agent_id] = target_dim
        logger.info("Created zvec topics collection at %s (dim=%s)", path, target_dim)
        return coll

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
            coll = self._ensure_topics_collection(agent_id, dim=dim)
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
            coll = self._ensure_topics_collection(agent_id)

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
            coll = self._ensure_topics_collection(agent_id)
            coll.delete_by_filter(f'agent_id == "{agent_id}"')
        except Exception:
            pass
