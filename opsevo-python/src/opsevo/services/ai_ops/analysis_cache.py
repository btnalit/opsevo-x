"""
AnalysisCache 分析缓存服务
缓存相似告警的 AI 分析结果，避免重复调用 AI。

- 当告警指纹匹配缓存的分析结果时直接返回
- 使用可配置的 TTL（默认 30 分钟）
- LRU 淘汰策略
"""

from __future__ import annotations

import time
from collections import OrderedDict
from dataclasses import dataclass

import structlog

logger = structlog.get_logger(__name__)


@dataclass
class AnalysisCacheConfig:
    default_ttl_s: float = 30 * 60  # 30 min
    max_size: int = 1000
    cleanup_interval_s: float = 5 * 60  # 5 min


@dataclass
class _CachedEntry:
    analysis: str
    created_at: float
    expires_at: float
    hit_count: int = 0


class AnalysisCache:
    """LRU 分析缓存，按指纹存储 AI 分析结果。"""

    def __init__(self, config: AnalysisCacheConfig | None = None) -> None:
        self._config = config or AnalysisCacheConfig()
        self._cache: OrderedDict[str, _CachedEntry] = OrderedDict()
        self._hit_count = 0
        self._miss_count = 0
        logger.info("AnalysisCache initialized", config=self._config)

    # ------------------------------------------------------------------
    def get(self, fingerprint: str) -> str | None:
        entry = self._cache.get(fingerprint)
        if entry is None:
            self._miss_count += 1
            return None
        if time.time() > entry.expires_at:
            del self._cache[fingerprint]
            self._miss_count += 1
            return None
        entry.hit_count += 1
        self._hit_count += 1
        self._cache.move_to_end(fingerprint)
        return entry.analysis

    def set(self, fingerprint: str, analysis: str, ttl_s: float | None = None) -> None:
        now = time.time()
        expires = now + (ttl_s if ttl_s is not None else self._config.default_ttl_s)

        if len(self._cache) >= self._config.max_size and fingerprint not in self._cache:
            self._evict_lru()

        self._cache[fingerprint] = _CachedEntry(
            analysis=analysis, created_at=now, expires_at=expires
        )
        self._cache.move_to_end(fingerprint)

    def has(self, fingerprint: str) -> bool:
        entry = self._cache.get(fingerprint)
        if entry is None:
            return False
        if time.time() > entry.expires_at:
            del self._cache[fingerprint]
            return False
        return True

    def delete(self, fingerprint: str) -> None:
        self._cache.pop(fingerprint, None)

    def cleanup(self) -> int:
        now = time.time()
        expired = [k for k, v in self._cache.items() if now > v.expires_at]
        for k in expired:
            del self._cache[k]
        if expired:
            logger.debug("AnalysisCache cleanup", removed=len(expired))
        return len(expired)

    def clear(self) -> None:
        self._cache.clear()
        self._hit_count = 0
        self._miss_count = 0
        logger.info("AnalysisCache cleared")

    def get_stats(self) -> dict:
        return {
            "size": len(self._cache),
            "hitCount": self._hit_count,
            "missCount": self._miss_count,
        }

    # ------------------------------------------------------------------
    def _evict_lru(self) -> None:
        now = time.time()
        # try to evict expired first
        for k in list(self._cache):
            if now > self._cache[k].expires_at:
                del self._cache[k]
                return
        # otherwise evict oldest (front of OrderedDict)
        if self._cache:
            self._cache.popitem(last=False)
