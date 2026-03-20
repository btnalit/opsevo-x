"""TracingService — trace event processing through pipeline stages.

Requirements: 9.6
Bugfix: LRU/maxlen=10000 防止 OOM，add_span/end_trace 防御性编程
"""

from __future__ import annotations

import time
from collections import OrderedDict
from typing import Any

from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class TracingService:
    def __init__(self, maxlen: int = 10000) -> None:
        self._traces: OrderedDict[str, list[dict[str, Any]]] = OrderedDict()
        self._maxlen = maxlen

    def _evict_if_needed(self) -> None:
        """淘汰最旧的 trace，保持 maxlen 限制。"""
        while len(self._traces) > self._maxlen:
            evicted_id, _ = self._traces.popitem(last=False)
            logger.warning("trace_evicted_by_lru", trace_id=evicted_id)

    def start_trace(self, trace_id: str) -> None:
        self._traces[trace_id] = [{"stage": "start", "timestamp": int(time.time() * 1000)}]
        self._evict_if_needed()

    def add_span(self, trace_id: str, stage: str, data: dict[str, Any] | None = None) -> None:
        if trace_id not in self._traces:
            logger.warning("add_span_trace_not_found", trace_id=trace_id, stage=stage)
            return
        self._traces[trace_id].append({
            "stage": stage, "timestamp": int(time.time() * 1000), **(data or {}),
        })
        # 刷新 LRU 顺序，防止活跃 trace 被错误淘汰
        self._traces.move_to_end(trace_id)

    def end_trace(self, trace_id: str) -> list[dict[str, Any]]:
        if trace_id not in self._traces:
            logger.warning("end_trace_not_found", trace_id=trace_id)
            return []
        spans = self._traces.pop(trace_id)
        spans.append({"stage": "end", "timestamp": int(time.time() * 1000)})
        return spans

    def get_trace(self, trace_id: str) -> list[dict[str, Any]]:
        return self._traces.get(trace_id, [])

    def get_all_traces(self) -> dict[str, list[dict[str, Any]]]:
        """返回所有 trace 的副本。"""
        return dict(self._traces)
