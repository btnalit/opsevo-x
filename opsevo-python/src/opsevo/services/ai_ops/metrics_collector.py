"""MetricsCollector — collect device metrics via DeviceDriver.collect_metrics().

Requirements: 9.2, 9.5
"""

from __future__ import annotations

import time
from typing import Any

from opsevo.data.datastore import DataStore
from opsevo.drivers.base import DeviceDriver
from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class MetricsCollector:
    def __init__(self, datastore: DataStore):
        self._ds = datastore
        self._history: dict[str, list[dict[str, Any]]] = {}

    async def collect(self, driver: DeviceDriver, device_id: str) -> dict[str, Any]:
        metrics = await driver.collect_metrics()
        record = {
            "device_id": device_id,
            "timestamp": int(time.time() * 1000),
            "cpu_usage": getattr(metrics, "cpu_usage", 0),
            "memory_usage": getattr(metrics, "memory_usage", 0),
            "uptime": getattr(metrics, "uptime", 0),
            "interfaces": [vars(i) if hasattr(i, "__dict__") else i for i in (getattr(metrics, "interfaces", []) or [])],
        }
        self._history.setdefault(device_id, []).append(record)
        if len(self._history[device_id]) > 100:
            self._history[device_id] = self._history[device_id][-100:]
        return record

    def get_history(self, device_id: str, limit: int = 50) -> list[dict[str, Any]]:
        return self._history.get(device_id, [])[-limit:]

    async def get_latest(self, device_id: str) -> dict[str, Any] | None:
        history = self._history.get(device_id, [])
        return history[-1] if history else None
