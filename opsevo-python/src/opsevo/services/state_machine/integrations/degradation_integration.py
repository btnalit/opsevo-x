"""DegradationIntegration — 状态机降级集成。"""
from __future__ import annotations
from typing import Any
import structlog

logger = structlog.get_logger(__name__)


class DegradationIntegration:
    def __init__(self, degradation_manager: Any = None) -> None:
        self._manager = degradation_manager

    async def check_degradation(self, flow_name: str) -> bool:
        """Returns True if flow should be degraded/skipped."""
        if self._manager and hasattr(self._manager, "is_degraded"):
            return self._manager.is_degraded(flow_name)
        return False

    async def report_failure(self, flow_name: str, error: str) -> None:
        if self._manager and hasattr(self._manager, "report_failure"):
            await self._manager.report_failure(flow_name, error)
