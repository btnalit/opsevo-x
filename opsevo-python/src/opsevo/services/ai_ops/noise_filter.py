"""NoiseFilter — filter low-value or duplicate alerts.

Requirements: 9.1
"""

from __future__ import annotations

from typing import Any

from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class NoiseFilter:
    def __init__(self, min_severity: str = "info"):
        self._min_severity = min_severity
        self._severity_order = {"debug": 0, "info": 1, "warning": 2, "high": 3, "critical": 4}

    def should_filter(self, event: dict[str, Any]) -> bool:
        severity = event.get("severity", "info")
        return self._severity_order.get(severity, 1) < self._severity_order.get(self._min_severity, 1)
