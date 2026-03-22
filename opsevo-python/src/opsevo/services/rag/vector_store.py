"""VectorStore — pgvector direct integration (merged from python-core).

Requirements: 10.5, 10.1
"""

from __future__ import annotations

import re
import uuid
from typing import Any

from opsevo.data.datastore import DataStore
from opsevo.services.rag.embedding import EmbeddingService
from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class VectorStore:
    TABLE = "knowledge_embeddings"

    def __init__(self, datastore: DataStore, embedding: EmbeddingService):
        self._ds = datastore
        self._emb = embedding
        self._table_dim: int | None = None
        self._dim_mismatch_logged: set[tuple[int, int]] = set()

    async def initialize(self) -> None:
        await self._ds.execute(
            f"""CREATE TABLE IF NOT EXISTS {self.TABLE} (
                id TEXT PRIMARY KEY,
                content TEXT NOT NULL,
                metadata JSONB DEFAULT '{{}}',
                embedding vector({self._emb.dimension}),
                created_at TIMESTAMPTZ DEFAULT NOW()
            )"""
        )
        await self._ds.execute(
            f"CREATE INDEX IF NOT EXISTS idx_{self.TABLE}_embedding ON {self.TABLE} "
            f"USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)"
        )
        self._table_dim = await self._detect_table_dimension()
        # 当表维度与 EmbeddingService 默认维度不一致时，优先对齐到表维度，
        # 减少无意义的截断/补零并保持查询一致性。
        if self._table_dim and self._table_dim != self._emb.dimension:
            old_dim = self._emb.dimension
            try:
                await self._emb.update_config({"dimensions": self._table_dim})
                logger.info(
                    "vector_store_embedding_dimension_aligned",
                    from_dim=old_dim,
                    to_dim=self._table_dim,
                )
            except Exception:
                logger.warning(
                    "vector_store_embedding_dimension_align_failed",
                    table_dim=self._table_dim,
                    embedding_dim=old_dim,
                    exc_info=True,
                )
        logger.info(
            "vector_store_initialized",
            embedding_dim=self._emb.dimension,
            table_dim=self._table_dim,
        )

    async def _detect_table_dimension(self) -> int | None:
        """Detect pgvector dimension from table schema, e.g. vector(384)."""
        row = await self._ds.query_one(
            """
            SELECT format_type(a.atttypid, a.atttypmod) AS embedding_type
            FROM pg_attribute a
            JOIN pg_class c ON c.oid = a.attrelid
            WHERE c.relname = $1
              AND a.attname = 'embedding'
              AND a.attnum > 0
              AND NOT a.attisdropped
            LIMIT 1
            """,
            (self.TABLE,),
        )
        if not row:
            return None
        typ = str(row.get("embedding_type") or "")
        m = re.search(r"vector\((\d+)\)", typ)
        if not m:
            return None
        try:
            return int(m.group(1))
        except ValueError:
            return None

    def _target_dim(self) -> int:
        return self._table_dim or self._emb.dimension

    def _align_vector(self, vec: list[float]) -> list[float]:
        """Align vector length to DB column dimension to avoid pgvector dimension errors."""
        target = self._target_dim()
        current = len(vec)
        if current == target:
            return vec
        key = (current, target)
        if key not in self._dim_mismatch_logged:
            self._dim_mismatch_logged.add(key)
            logger.warning("vector_dimension_mismatch_auto_aligned", current=current, target=target)
        if current > target:
            return vec[:target]
        return vec + [0.0] * (target - current)

    async def add(self, content: str, metadata: dict | None = None) -> str:
        doc_id = str(uuid.uuid4())
        vec = self._align_vector(await self._emb.embed_single(content))
        await self._ds.execute(
            f"INSERT INTO {self.TABLE} (id, content, metadata, embedding) VALUES ($1, $2, $3::jsonb, $4::vector)",
            (doc_id, content, _json_str(metadata or {}), vec),
        )
        return doc_id

    async def add_batch(self, items: list[dict[str, Any]]) -> list[str]:
        texts = [item["content"] for item in items]
        vectors = await self._emb.embed(texts)
        ids = []
        for item, vec in zip(items, vectors):
            doc_id = str(uuid.uuid4())
            aligned = self._align_vector(vec)
            await self._ds.execute(
                f"INSERT INTO {self.TABLE} (id, content, metadata, embedding) VALUES ($1, $2, $3::jsonb, $4::vector)",
                (doc_id, item["content"], _json_str(item.get("metadata", {})), aligned),
            )
            ids.append(doc_id)
        return ids

    async def search(self, query: str, top_k: int = 5, threshold: float = 0.0) -> list[dict[str, Any]]:
        vec = self._align_vector(await self._emb.embed_single(query))
        if threshold > 0:
            rows = await self._ds.query(
                f"SELECT id, content, metadata, 1 - (embedding <=> $1::vector) AS score "
                f"FROM {self.TABLE} WHERE 1 - (embedding <=> $1::vector) >= $3 "
                f"ORDER BY embedding <=> $1::vector LIMIT $2",
                (vec, top_k, threshold),
            )
        else:
            rows = await self._ds.query(
                f"SELECT id, content, metadata, 1 - (embedding <=> $1::vector) AS score "
                f"FROM {self.TABLE} ORDER BY embedding <=> $1::vector LIMIT $2",
                (vec, top_k),
            )
        return rows

    async def delete(self, doc_id: str) -> bool:
        return (await self._ds.execute(f"DELETE FROM {self.TABLE} WHERE id = $1", (doc_id,))) > 0

    async def count(self) -> int:
        row = await self._ds.query_one(f"SELECT COUNT(*) as cnt FROM {self.TABLE}")
        return row["cnt"] if row else 0


def _json_str(d: dict) -> str:
    import json
    return json.dumps(d, ensure_ascii=False)
