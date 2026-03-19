"""Reranker — re-ranks search results using an external reranker API.

Requirements: 11.5
"""

from __future__ import annotations

from typing import Any

import httpx

from opsevo.settings import Settings
from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class Reranker:
    def __init__(self, settings: Settings):
        self._api_key = settings.rerank_api_key
        self._base_url = settings.rerank_base_url
        self._model = settings.rerank_model_name
        self._top_k = settings.rerank_top_k
        self._threshold = settings.rerank_threshold
        self._timeout = settings.rerank_timeout / 1000

    @property
    def enabled(self) -> bool:
        return bool(self._api_key and self._base_url)

    async def rerank(self, query: str, documents: list[str], top_k: int | None = None) -> list[dict[str, Any]]:
        if not self.enabled:
            return [{"index": i, "text": d, "score": 1.0} for i, d in enumerate(documents)]

        k = top_k or self._top_k
        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                resp = await client.post(
                    f"{self._base_url}/rerank",
                    json={"model": self._model, "query": query, "documents": documents, "top_n": k},
                    headers={"Authorization": f"Bearer {self._api_key}"},
                )
                resp.raise_for_status()
                results = resp.json().get("results", [])
                return [r for r in results if r.get("relevance_score", 0) >= self._threshold]
        except Exception as exc:
            logger.error("rerank_failed", error=str(exc))
            return [{"index": i, "text": d, "score": 1.0} for i, d in enumerate(documents[:k])]
