"""EmbeddingService — multi-provider text embedding with DB config auto-discovery.

Ported from TS backend embeddingService.ts.
Supports: openai, gemini, deepseek, qwen, zhipu
Auto-reads API keys from ai_configs table, in-memory cache with TTL,
batch embedding, vector normalization, exponential backoff retry.

Requirements: 10.5, 10.1
"""

from __future__ import annotations

import asyncio
import hashlib
import math
import time
from dataclasses import dataclass, field
from typing import Any, Literal

import httpx

from opsevo.data.datastore import DataStore
from opsevo.services.ai.crypto_service import CryptoService
from opsevo.settings import Settings
from opsevo.utils.logger import get_logger

logger = get_logger(__name__)

EmbeddingProvider = Literal["openai", "gemini", "deepseek", "qwen", "zhipu"]

# ── Provider defaults ─────────────────────────────────────────────────────

DEFAULT_MODELS: dict[EmbeddingProvider, str] = {
    "openai": "text-embedding-3-small",
    "gemini": "gemini-embedding-2-preview",
    "deepseek": "deepseek-embedding",
    "qwen": "text-embedding-v3",
    "zhipu": "embedding-3",
}

DIMENSIONS: dict[EmbeddingProvider, int] = {
    "openai": 1536,
    "gemini": 3072,
    "deepseek": 1024,
    "qwen": 1024,
    "zhipu": 2048,
}

ENDPOINTS: dict[EmbeddingProvider, str] = {
    "openai": "https://api.openai.com/v1/embeddings",
    "gemini": "https://generativelanguage.googleapis.com/v1beta/models",
    "deepseek": "https://api.deepseek.com/v1/embeddings",
    "qwen": "https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding",
    "zhipu": "https://open.bigmodel.cn/api/paas/v4/embeddings",
}

# Provider priority for auto-discovery (Gemini free tier first)
SUPPORTED_PROVIDERS: list[EmbeddingProvider] = ["gemini", "openai", "qwen", "zhipu"]

CACHE_TTL_MS = 24 * 60 * 60 * 1000  # 24h
MAX_RETRIES = 3
REQUEST_TIMEOUT = 15.0
DEFAULT_BATCH_SIZE = 100


@dataclass
class _CacheEntry:
    vector: list[float]
    model: str
    dimensions: int
    created_at: float  # time.time() seconds
    ttl: float  # expiry timestamp (seconds)


@dataclass
class EmbeddingConfig:
    provider: EmbeddingProvider = "openai"
    model: str = ""
    dimensions: int = 0
    batch_size: int = DEFAULT_BATCH_SIZE
    cache_enabled: bool = True
    cache_ttl_ms: int = CACHE_TTL_MS


class EmbeddingService:
    """Multi-provider embedding service with DB config auto-discovery."""

    def __init__(
        self,
        settings: Settings,
        datastore: DataStore | None = None,
        crypto_service: CryptoService | None = None,
    ):
        self._settings = settings
        self._ds = datastore
        self._crypto = crypto_service

        self._config = EmbeddingConfig()
        self._api_key: str | None = None
        self._endpoint: str | None = None
        self._initialized = False

        # cache
        self._cache: dict[str, _CacheEntry] = {}
        self._cache_hits = 0
        self._cache_misses = 0

    # ── Initialization ────────────────────────────────────────────────────

    async def initialize(self) -> None:
        if self._initialized:
            await self._refresh_config()
            return
        await self._refresh_config()
        # Fallback defaults
        if not self._config.model:
            self._config.model = DEFAULT_MODELS[self._config.provider]
        if not self._config.dimensions:
            self._config.dimensions = DIMENSIONS[self._config.provider]
        self._initialized = True
        logger.info(
            "embedding_service_initialized",
            provider=self._config.provider,
            model=self._config.model,
            dimensions=self._config.dimensions,
        )

    async def _refresh_config(self) -> None:
        """Read ai_configs from DB and pick the best provider with a valid key."""
        if not self._ds or not self._crypto:
            # No DB access — fall back to env vars
            self._apply_env_fallback()
            return
        try:
            rows = await self._ds.query(
                "SELECT id, provider, api_key_encrypted, base_url FROM ai_configs ORDER BY created_at DESC"
            )
            if not rows:
                self._apply_env_fallback()
                return

            # Try preferred providers first
            for preferred in SUPPORTED_PROVIDERS:
                for row in rows:
                    if row.get("provider") == preferred:
                        encrypted = row.get("api_key_encrypted", "")
                        if not encrypted:
                            continue
                        key = self._crypto.decrypt(encrypted)
                        if not key:
                            continue
                        self._api_key = key
                        self._endpoint = ENDPOINTS[preferred]
                        if self._config.provider != preferred:
                            self._config.provider = preferred
                            self._config.model = DEFAULT_MODELS[preferred]
                            self._config.dimensions = DIMENSIONS[preferred]
                        return

            # Fallback: any row with a known provider
            for row in rows:
                p = row.get("provider", "")
                if p in ENDPOINTS:
                    encrypted = row.get("api_key_encrypted", "")
                    if not encrypted:
                        continue
                    key = self._crypto.decrypt(encrypted)
                    if not key:
                        continue
                    self._api_key = key
                    self._endpoint = ENDPOINTS[p]  # type: ignore[index]
                    self._config.provider = p  # type: ignore[assignment]
                    self._config.model = DEFAULT_MODELS.get(p, "")  # type: ignore[arg-type]
                    self._config.dimensions = DIMENSIONS.get(p, 1024)  # type: ignore[arg-type]
                    return

            # Nothing usable in DB
            self._apply_env_fallback()
        except Exception:
            logger.warning("embedding_refresh_config_failed", exc_info=True)
            self._apply_env_fallback()

    def _apply_env_fallback(self) -> None:
        """Use settings env vars as fallback when DB has no usable config."""
        s = self._settings
        provider = (s.embedding_provider or s.ai_provider).lower()
        if provider in ENDPOINTS:
            self._config.provider = provider  # type: ignore[assignment]
        if s.embedding_remote_api_key:
            self._api_key = s.embedding_remote_api_key
        if s.embedding_remote_url:
            self._endpoint = s.embedding_remote_url
        elif provider in ENDPOINTS:
            self._endpoint = ENDPOINTS[self._config.provider]
        if s.embedding_model_name:
            self._config.model = s.embedding_model_name

    # ── Public API ────────────────────────────────────────────────────────

    async def embed_single(self, text: str) -> list[float]:
        results = await self.embed([text])
        return results[0] if results else []

    async def embed(self, texts: list[str]) -> list[list[float]]:
        """Embed a list of texts. Uses cache + batching."""
        if not texts:
            return []

        results: list[list[float] | None] = [None] * len(texts)
        uncached_texts: list[str] = []
        uncached_indices: list[int] = []

        for i, text in enumerate(texts):
            if self._config.cache_enabled:
                cached = self._get_from_cache(text)
                if cached is not None:
                    self._cache_hits += 1
                    results[i] = cached.vector
                    continue
                self._cache_misses += 1
            uncached_texts.append(text)
            uncached_indices.append(i)

        if uncached_texts:
            bs = self._config.batch_size or DEFAULT_BATCH_SIZE
            for start in range(0, len(uncached_texts), bs):
                batch = uncached_texts[start : start + bs]
                batch_idx = uncached_indices[start : start + bs]
                vectors = await self._call_with_retry(batch)
                for j, vec in enumerate(vectors):
                    normalized = self._normalize(vec)
                    idx = batch_idx[j]
                    results[idx] = normalized
                    if self._config.cache_enabled:
                        self._set_cache(batch[j], normalized)

        return [r for r in results if r is not None]

    # ── Provider dispatch ─────────────────────────────────────────────────

    async def _call_with_retry(self, texts: list[str]) -> list[list[float]]:
        if not self._api_key:
            # Try one more refresh before giving up
            await self._refresh_config()
            if not self._api_key:
                raise RuntimeError("No API key configured for embedding. Add an AI provider config first.")

        last_err: Exception | None = None
        for attempt in range(MAX_RETRIES):
            try:
                return await self._do_request(texts)
            except Exception as exc:
                last_err = exc
                logger.warning(
                    "embedding_api_failed",
                    attempt=attempt + 1,
                    max=MAX_RETRIES,
                    error=str(exc),
                )
                if attempt < MAX_RETRIES - 1:
                    await asyncio.sleep(2**attempt)
        raise last_err or RuntimeError("Embedding API failed after retries")

    async def _do_request(self, texts: list[str]) -> list[list[float]]:
        endpoint = self._endpoint or ENDPOINTS[self._config.provider]
        model = self._config.model or DEFAULT_MODELS[self._config.provider]
        p = self._config.provider

        if p in ("openai", "deepseek"):
            return await self._call_openai_compatible(endpoint, model, texts)
        if p == "gemini":
            return await self._call_gemini(endpoint, model, texts)
        if p == "qwen":
            return await self._call_qwen(endpoint, model, texts)
        if p == "zhipu":
            return await self._call_zhipu(endpoint, model, texts)
        raise ValueError(f"Unsupported embedding provider: {p}")

    # ── OpenAI / DeepSeek ─────────────────────────────────────────────────

    async def _call_openai_compatible(
        self, endpoint: str, model: str, texts: list[str]
    ) -> list[list[float]]:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
            resp = await client.post(
                endpoint,
                json={"model": model, "input": texts},
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {self._api_key}",
                },
            )
            resp.raise_for_status()
            data = resp.json()
            items = sorted(data["data"], key=lambda x: x["index"])
            return [item["embedding"] for item in items]

    # ── Gemini ────────────────────────────────────────────────────────────

    async def _call_gemini(
        self, endpoint: str, model: str, texts: list[str]
    ) -> list[list[float]]:
        async def _embed_one(client: httpx.AsyncClient, text: str) -> list[float]:
            url = f"{endpoint}/{model}:embedContent?key={self._api_key}"
            resp = await client.post(
                url,
                json={
                    "content": {"parts": [{"text": text}]},
                    "outputDimensionality": self._config.dimensions or DIMENSIONS["gemini"],
                },
                headers={"Content-Type": "application/json"},
            )
            resp.raise_for_status()
            data = resp.json()
            return data["embedding"]["values"]

        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
            tasks = [_embed_one(client, text) for text in texts]
            return list(await asyncio.gather(*tasks))

    # ── Qwen (DashScope) ──────────────────────────────────────────────────

    async def _call_qwen(
        self, endpoint: str, model: str, texts: list[str]
    ) -> list[list[float]]:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
            resp = await client.post(
                endpoint,
                json={
                    "model": model,
                    "input": {"texts": texts},
                    "parameters": {"text_type": "document"},
                },
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {self._api_key}",
                },
            )
            resp.raise_for_status()
            data = resp.json()
            return [item["embedding"] for item in data["output"]["embeddings"]]

    # ── Zhipu ─────────────────────────────────────────────────────────────

    async def _call_zhipu(
        self, endpoint: str, model: str, texts: list[str]
    ) -> list[list[float]]:
        async def _embed_one(client: httpx.AsyncClient, text: str) -> list[float]:
            resp = await client.post(
                endpoint,
                json={"model": model, "input": text},
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {self._api_key}",
                },
            )
            resp.raise_for_status()
            data = resp.json()
            return data["data"][0]["embedding"]

        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
            tasks = [_embed_one(client, text) for text in texts]
            return list(await asyncio.gather(*tasks))

    # ── Vector normalization ──────────────────────────────────────────────

    @staticmethod
    def _normalize(vector: list[float]) -> list[float]:
        norm = math.sqrt(sum(v * v for v in vector))
        if norm == 0:
            return vector
        return [v / norm for v in vector]

    # ── Cache helpers ─────────────────────────────────────────────────────

    def _cache_key(self, text: str) -> str:
        h = hashlib.md5(text.encode()).hexdigest()
        return f"{self._config.provider}:{self._config.model}:{h}"

    def _get_from_cache(self, text: str) -> _CacheEntry | None:
        key = self._cache_key(text)
        entry = self._cache.get(key)
        if entry is None:
            return None
        if time.time() > entry.ttl:
            del self._cache[key]
            return None
        return entry

    def _set_cache(self, text: str, vector: list[float]) -> None:
        key = self._cache_key(text)
        ttl_s = (self._config.cache_ttl_ms or CACHE_TTL_MS) / 1000.0
        self._cache[key] = _CacheEntry(
            vector=vector,
            model=self._config.model,
            dimensions=len(vector),
            created_at=time.time(),
            ttl=time.time() + ttl_s,
        )

    def clear_cache(self) -> None:
        self._cache.clear()
        self._cache_hits = 0
        self._cache_misses = 0
        logger.info("embedding_cache_cleared")

    def get_cache_stats(self) -> dict[str, Any]:
        total = self._cache_hits + self._cache_misses
        return {
            "size": len(self._cache),
            "hitRate": self._cache_hits / total if total > 0 else 0.0,
        }

    # ── Config accessors ──────────────────────────────────────────────────

    def get_config(self) -> dict[str, Any]:
        return {
            "provider": self._config.provider,
            "model": self._config.model,
            "dimensions": self._config.dimensions,
            "batchSize": self._config.batch_size,
            "cacheEnabled": self._config.cache_enabled,
            "cacheTtlMs": self._config.cache_ttl_ms,
        }

    async def update_config(self, cfg: dict[str, Any]) -> None:
        provider_changed = "provider" in cfg and cfg["provider"] != self._config.provider
        if "provider" in cfg:
            p = cfg["provider"]
            if p in ENDPOINTS:
                self._config.provider = p
        if "model" in cfg:
            self._config.model = cfg["model"]
        if "dimensions" in cfg:
            self._config.dimensions = cfg["dimensions"]
        if "batchSize" in cfg:
            self._config.batch_size = cfg["batchSize"]
        if "cacheEnabled" in cfg:
            self._config.cache_enabled = cfg["cacheEnabled"]
        if "cacheTtlMs" in cfg:
            self._config.cache_ttl_ms = cfg["cacheTtlMs"]

        if provider_changed:
            self._initialized = False
            self._api_key = None
            self._endpoint = None
            await self.initialize()
        # Ensure defaults
        if not self._config.model:
            self._config.model = DEFAULT_MODELS[self._config.provider]
        if not self._config.dimensions:
            self._config.dimensions = DIMENSIONS[self._config.provider]
        logger.info("embedding_config_updated", config=self.get_config())

    @property
    def dimension(self) -> int:
        """Backward-compatible property used by VectorStore."""
        return self._config.dimensions or DIMENSIONS.get(self._config.provider, 1024)

    @property
    def provider(self) -> str:
        return self._config.provider

    @property
    def model_name(self) -> str:
        return self._config.model

    @property
    def is_initialized(self) -> bool:
        return self._initialized
