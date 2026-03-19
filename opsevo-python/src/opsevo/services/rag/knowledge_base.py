"""KnowledgeBase — manages knowledge entries with CRUD + search.

Requirements: 10.1, 10.6
"""

from __future__ import annotations

import uuid
from typing import Any

from opsevo.data.datastore import DataStore
from opsevo.services.rag.vector_store import VectorStore
from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class KnowledgeBase:
    def __init__(self, datastore: DataStore, vector_store: VectorStore):
        self._ds = datastore
        self._vs = vector_store

    async def add_entry(self, content: str, metadata: dict | None = None, tags: list[str] | None = None) -> str:
        meta = metadata or {}
        if tags:
            meta["tags"] = tags
        doc_id = await self._vs.add(content, meta)
        logger.info("knowledge_entry_added", id=doc_id)
        return doc_id

    async def search(self, query: str, top_k: int = 5, threshold: float = 0.3) -> list[dict[str, Any]]:
        return await self._vs.search(query, top_k=top_k, threshold=threshold)

    async def delete_entry(self, entry_id: str) -> bool:
        return await self._vs.delete(entry_id)

    async def count(self) -> int:
        return await self._vs.count()
