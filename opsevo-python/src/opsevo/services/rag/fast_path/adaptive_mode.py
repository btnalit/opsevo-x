"""Adaptive mode — adjusts fast-path behavior based on hit rate.
Requirements: 10.3
"""
from __future__ import annotations
from opsevo.services.rag.fast_path.metrics import FastPathMetrics

class AdaptiveMode:
    def __init__(self, metrics: FastPathMetrics, threshold: float = 0.3):
        self._metrics = metrics
        self._threshold = threshold

    @property
    def should_try_fast_path(self) -> bool:
        stats = self._metrics.get_stats()
        return stats["hitRate"] >= self._threshold or (stats["hits"] + stats["misses"]) < 10
