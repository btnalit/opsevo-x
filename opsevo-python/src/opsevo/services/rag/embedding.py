"""EmbeddingService — local sentence-transformers or remote API.

Merged from python-core: direct function call, no HTTP intermediary.
Requirements: 10.5, 10.1
"""

from __future__ import annotations

from typing import Any

import httpx

from opsevo.settings import Settings
from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class EmbeddingService:
    def __init__(self, settings: Settings):
        self._settings = settings
        self._model: Any = None
        self._remote_url = settings.embedding_remote_url
        self._remote_key = settings.embedding_remote_api_key
        self._provider = settings.embedding_provider or settings.ai_provider
        self._model_name = settings.embedding_model_name

    async def initialize(self) -> None:
        if not self._remote_url:
            try:
                from sentence_transformers import SentenceTransformer
                self._model = SentenceTransformer(self._settings.embedding_model)
                logger.info("embedding_local_loaded", model=self._settings.embedding_model)
            except ImportError:
                logger.warning("sentence_transformers_not_installed")
        else:
            logger.info("embedding_remote_configured", url=self._remote_url)

    async def embed(self, texts: list[str]) -> list[list[float]]:
        if self._model is not None:
            return self._model.encode(texts).tolist()
        return await self._embed_remote(texts)

    async def embed_single(self, text: str) -> list[float]:
        results = await self.embed([text])
        return results[0] if results else []

    async def _embed_remote(self, texts: list[str]) -> list[list[float]]:
        headers: dict[str, str] = {}
        if self._remote_key:
            headers["Authorization"] = f"Bearer {self._remote_key}"
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                self._remote_url,
                json={"input": texts, "model": self._model_name or self._settings.embedding_model},
                headers=headers,
            )
            resp.raise_for_status()
            data = resp.json()
            # OpenAI-compatible format
            if "data" in data:
                return [item["embedding"] for item in data["data"]]
            # Simple format
            return data.get("embeddings", [])

    @property
    def dimension(self) -> int:
        if self._model is not None:
            return self._model.get_sentence_embedding_dimension()
        return 384  # default for all-MiniLM-L6-v2
