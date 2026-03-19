"""TracingService — trace event processing through pipeline stages.

Requirements: 9.6
"""

from __future__ import annotations

import time
from typing import Any

from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class TracingService:
    def __init__(self) -> None:
        self._traces: dict[str, list[dict[str, Any]]] = {}

    def start_trace(self, trace_id: str) -> None:
        self._traces[trace_id] = [{"stage": "start", "timestamp": int(time.time() * 1000)}]

    def add_span(self, trace_id: str, stage: str, data: dict[str, Any] | None = None) -> None:
        if trace_id in self._traces:
            self._traces[trace_id].append({
                "stage": stage, "timestamp": int(time.time() * 1000), **(data or {}),
            })

    def end_trace(self, trace_id: str) -> list[dict[str, Any]]:
        spans = self._traces.pop(trace_id, [])
        spans.append({"stage": "end", "timestamp": int(time.time() * 1000)})
        return spans

    def get_trace(self, trace_id: str) -> list[dict[str, Any]]:
        return self._traces.get(trace_id, [])
