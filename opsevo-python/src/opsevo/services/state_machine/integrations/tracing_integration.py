"""TracingIntegration — 状态机追踪集成。"""
from __future__ import annotations
import time
from typing import Any
import structlog

logger = structlog.get_logger(__name__)


class TracingIntegration:
    def __init__(self, tracing_service: Any = None) -> None:
        self._tracing = tracing_service

    def start_span(self, flow_name: str, state: str, instance_id: str) -> dict[str, Any]:
        span = {
            "flow": flow_name,
            "state": state,
            "instance_id": instance_id,
            "start_time": time.time(),
        }
        if self._tracing and hasattr(self._tracing, "start_span"):
            self._tracing.start_span(span)
        return span

    def end_span(self, span: dict[str, Any], result: str) -> None:
        span["end_time"] = time.time()
        span["duration_ms"] = (span["end_time"] - span["start_time"]) * 1000
        span["result"] = result
        if self._tracing and hasattr(self._tracing, "end_span"):
            self._tracing.end_span(span)
