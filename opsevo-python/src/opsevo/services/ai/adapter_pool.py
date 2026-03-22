"""AdapterPool — LRU cache for AI adapters with auto-cleanup.

Requirements: 11.3
"""

from __future__ import annotations

import hashlib
import time
from collections import OrderedDict
from typing import Any

from opsevo.services.ai.adapters.base import AIAdapter
from opsevo.services.ai.adapters.factory import create_adapter
from opsevo.settings import Settings
from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class AdapterPool:
    """Manages a pool of AI adapters with LRU eviction."""

    def __init__(self, settings: Settings, max_size: int = 10, ttl_seconds: int = 3600):
        self._settings = settings
        self._max_size = max_size
        self._ttl = ttl_seconds
        self._cache: OrderedDict[str, tuple[AIAdapter, float]] = OrderedDict()

    def _cache_key(self, provider: str, model: str = "", api_key: str = "", base_url: str = "") -> str:
        # Include API key fingerprint so switching keys does not reuse stale adapters.
        key_fingerprint = hashlib.sha256(api_key.encode("utf-8")).hexdigest()[:16] if api_key else ""
        return f"{provider}:{model}:{base_url}:{key_fingerprint}"

    async def get_adapter(
        self,
        provider: str = "",
        *,
        model: str = "",
        api_key: str = "",
        base_url: str = "",
    ) -> AIAdapter:
        provider = provider or self._settings.ai_provider
        key = self._cache_key(provider, model, api_key, base_url)

        if key in self._cache:
            adapter, ts = self._cache[key]
            if time.time() - ts < self._ttl:
                self._cache.move_to_end(key)
                return adapter
            # Expired — close and recreate
            await adapter.close()
            del self._cache[key]

        # Evict LRU if full
        while len(self._cache) >= self._max_size:
            _, (old_adapter, _) = self._cache.popitem(last=False)
            await old_adapter.close()

        adapter = create_adapter(provider, self._settings, model=model, api_key=api_key, base_url=base_url)
        self._cache[key] = (adapter, time.time())
        logger.info("adapter_created", provider=provider, model=model)
        return adapter

    async def close_all(self) -> None:
        for adapter, _ in self._cache.values():
            try:
                await adapter.close()
            except Exception:
                pass
        self._cache.clear()

    @property
    def size(self) -> int:
        return len(self._cache)
