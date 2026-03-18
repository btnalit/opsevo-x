"""Embedding service with dual-mode support: local model and remote API."""

import logging
from typing import Any

import httpx
import numpy as np

from config import settings

logger = logging.getLogger(__name__)


class EmbeddingService:
    """Generate text embeddings using local sentence-transformers or a remote API.

    Mode selection:
    - If EMBEDDING_REMOTE_URL is set, use remote mode (OpenAI-compatible API).
    - Otherwise, use local mode (sentence-transformers model).

    The local model is loaded lazily on first call and cached for reuse.
    """

    def __init__(self) -> None:
        self._local_model: Any = None
        self._model_name: str = settings.EMBEDDING_MODEL
        self._remote_url: str | None = settings.EMBEDDING_REMOTE_URL
        self._remote_api_key: str | None = settings.EMBEDDING_REMOTE_API_KEY

    @property
    def is_remote(self) -> bool:
        """Return True when configured to use a remote embedding API."""
        return self._remote_url is not None

    @property
    def model_name(self) -> str:
        return self._model_name

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def embed(self, texts: list[str]) -> list[list[float]]:
        """Return embedding vectors for *texts*.

        Raises:
            RuntimeError: If the model cannot be loaded or the remote API fails.
        """
        if self.is_remote:
            return await self._embed_remote(texts)
        return await self._embed_local(texts)

    # ------------------------------------------------------------------
    # Local mode
    # ------------------------------------------------------------------

    def _load_local_model(self) -> Any:
        """Lazily load the sentence-transformers model (cached after first call)."""
        if self._local_model is not None:
            return self._local_model

        try:
            from sentence_transformers import SentenceTransformer

            logger.info("Loading local embedding model: %s", self._model_name)
            self._local_model = SentenceTransformer(self._model_name)
            logger.info("Local embedding model loaded successfully")
            return self._local_model
        except Exception as exc:
            logger.error("Failed to load local embedding model: %s", exc)
            raise RuntimeError(
                f"Failed to load embedding model '{self._model_name}': {exc}"
            ) from exc

    async def _embed_local(self, texts: list[str]) -> list[list[float]]:
        """Generate embeddings using the local sentence-transformers model."""
        model = self._load_local_model()
        try:
            embeddings: np.ndarray = model.encode(texts, convert_to_numpy=True)
            return embeddings.tolist()
        except Exception as exc:
            logger.error("Local embedding failed: %s", exc)
            raise RuntimeError(f"Local embedding failed: {exc}") from exc

    # ------------------------------------------------------------------
    # Remote mode (OpenAI-compatible API)
    # ------------------------------------------------------------------

    async def _embed_remote(self, texts: list[str]) -> list[list[float]]:
        """Generate embeddings via a remote OpenAI-compatible API."""
        headers: dict[str, str] = {"Content-Type": "application/json"}
        if self._remote_api_key:
            headers["Authorization"] = f"Bearer {self._remote_api_key}"

        payload = {
            "input": texts,
            "model": self._model_name,
        }

        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    self._remote_url,  # type: ignore[arg-type]
                    json=payload,
                    headers=headers,
                )
                response.raise_for_status()
                data = response.json()

            # OpenAI response format: { "data": [ { "embedding": [...] }, ... ] }
            embeddings = [item["embedding"] for item in data["data"]]
            return embeddings
        except httpx.TimeoutException as exc:
            logger.error("Remote embedding API timed out: %s", exc)
            raise RuntimeError(
                f"Remote embedding API timed out: {exc}"
            ) from exc
        except httpx.HTTPStatusError as exc:
            logger.error(
                "Remote embedding API returned %s: %s",
                exc.response.status_code,
                exc.response.text,
            )
            raise RuntimeError(
                f"Remote embedding API error ({exc.response.status_code}): "
                f"{exc.response.text}"
            ) from exc
        except Exception as exc:
            logger.error("Remote embedding request failed: %s", exc)
            raise RuntimeError(
                f"Remote embedding request failed: {exc}"
            ) from exc

    # ------------------------------------------------------------------
    # Lifecycle helpers
    # ------------------------------------------------------------------

    def get_dimensions(self) -> int:
        """Return the embedding dimensions for the current model.

        For the local all-MiniLM-L6-v2 model this is 384.
        For remote models the dimension is unknown until the first call,
        so we return 0 as a sentinel.
        """
        if not self.is_remote and self._local_model is not None:
            return self._local_model.get_sentence_embedding_dimension()
        # Default for all-MiniLM-L6-v2
        if self._model_name == "all-MiniLM-L6-v2":
            return 384
        return 0
