"""VectorStore — pgvector direct integration (merged from python-core).

Requirements: 10.5, 10.1
"""

from __future__ import annotations

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
        logger.info("vector_store_initialized")

    async def add(self, content: str, metadata: dict | None = None) -> str:
        doc_id = str(uuid.uuid4())
        vec = await self._emb.embed_single(content)
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
            await self._ds.execute(
                f"INSERT INTO {self.TABLE} (id, content, metadata, embedding) VALUES ($1, $2, $3::jsonb, $4::vector)",
                (doc_id, item["content"], _json_str(item.get("metadata", {})), vec),
            )
            ids.append(doc_id)
        return ids

    async def search(self, query: str, top_k: int = 5, threshold: float = 0.0) -> list[dict[str, Any]]:
        vec = await self._emb.embed_single(query)
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
