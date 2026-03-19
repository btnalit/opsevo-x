"""HybridSearchEngine — keyword + vector hybrid retrieval.

Requirements: 10.1, 10.6
"""

from __future__ import annotations

from typing import Any

from opsevo.data.datastore import DataStore
from opsevo.services.rag.rrf_ranker import rrf_merge
from opsevo.services.rag.vector_store import VectorStore
from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class HybridSearchEngine:
    def __init__(self, datastore: DataStore, vector_store: VectorStore):
        self._ds = datastore
        self._vs = vector_store

    async def search(self, query: str, top_k: int = 10, threshold: float = 0.3) -> list[dict[str, Any]]:
        vector_results = await self._vs.search(query, top_k=top_k, threshold=threshold)
        keyword_results = await self._keyword_search(query, top_k=top_k)
        merged = rrf_merge(vector_results, keyword_results, top_n=top_k)
        return merged

    async def _keyword_search(self, query: str, top_k: int = 10) -> list[dict[str, Any]]:
        tsquery = " & ".join(query.split()[:10])
        if not tsquery:
            return []
        try:
            rows = await self._ds.query(
                "SELECT id, content, metadata, ts_rank(to_tsvector('simple', content), to_tsquery('simple', $1)) AS score "
                "FROM knowledge_embeddings WHERE to_tsvector('simple', content) @@ to_tsquery('simple', $1) "
                "ORDER BY score DESC LIMIT $2",
                (tsquery, top_k),
            )
            return rows
        except Exception:
            return []
