"""HealthMonitor — periodic device health checks.

Requirements: 9.2, 9.5
"""

from __future__ import annotations

import time
from typing import Any

from opsevo.events.event_bus import EventBus
from opsevo.events.types import EventType, PerceptionEvent, Priority
from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class HealthMonitor:
    def __init__(self, event_bus: EventBus):
        self._event_bus = event_bus
        self._device_status: dict[str, dict[str, Any]] = {}

    async def check_device(self, device_id: str, driver: Any) -> dict[str, Any]:
        try:
            result = await driver.health_check()
            status = {
                "device_id": device_id,
                "healthy": result.healthy if hasattr(result, "healthy") else True,
                "latency_ms": result.latency_ms if hasattr(result, "latency_ms") else 0,
                "timestamp": int(time.time() * 1000),
            }
        except Exception as exc:
            status = {"device_id": device_id, "healthy": False, "error": str(exc),
                      "timestamp": int(time.time() * 1000)}
        prev = self._device_status.get(device_id, {})
        self._device_status[device_id] = status
        if prev.get("healthy") and not status.get("healthy"):
            await self._event_bus.publish(PerceptionEvent(
                type=EventType.ALERT, priority=Priority.HIGH,
                source="health_monitor",
                payload={"device_id": device_id, "status": "down"}, schema_version="1.0",
            ))
        return status

    def get_all_status(self) -> dict[str, dict[str, Any]]:
        return dict(self._device_status)

    def get_device_status(self, device_id: str) -> dict[str, Any] | None:
        return self._device_status.get(device_id)

    async def get_summary(self) -> dict[str, Any]:
        """Aggregate device statuses into an overall health summary."""
        statuses = list(self._device_status.values())
        total = len(statuses)
        if total == 0:
            return {"total": 0, "healthy": 0, "unhealthy": 0, "overall": 100}
        healthy = sum(1 for s in statuses if s.get("healthy"))
        avg_latency = sum(s.get("latency_ms", 0) for s in statuses) / total
        overall = int((healthy / total) * 100)
        return {
            "total": total,
            "healthy": healthy,
            "unhealthy": total - healthy,
            "overall": overall,
            "avg_latency_ms": round(avg_latency, 1),
        }
