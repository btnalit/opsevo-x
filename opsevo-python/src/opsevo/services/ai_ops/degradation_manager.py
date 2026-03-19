"""DegradationManager — graceful degradation when services are unavailable.

Requirements: 9.6
"""

from __future__ import annotations

from typing import Any

from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class DegradationManager:
    def __init__(self) -> None:
        self._degraded_services: dict[str, dict[str, Any]] = {}

    def mark_degraded(self, service: str, reason: str = "") -> None:
        self._degraded_services[service] = {"reason": reason, "degraded": True}
        logger.warning("service_degraded", service=service, reason=reason)

    def mark_healthy(self, service: str) -> None:
        self._degraded_services.pop(service, None)

    def is_degraded(self, service: str) -> bool:
        return service in self._degraded_services

    def get_status(self) -> dict[str, dict[str, Any]]:
        return dict(self._degraded_services)
