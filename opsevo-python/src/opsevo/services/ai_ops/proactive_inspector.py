"""ProactiveInspector — proactive device inspection.

Requirements: 9.5
"""

from __future__ import annotations

from typing import Any

from opsevo.drivers.base import DeviceDriver
from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class ProactiveInspector:
    def __init__(self) -> None:
        self._checks: list[dict[str, Any]] = []

    def register_check(self, name: str, action_type: str, threshold: dict[str, Any] | None = None) -> None:
        self._checks.append({"name": name, "action_type": action_type, "threshold": threshold or {}})

    async def inspect(self, driver: DeviceDriver, device_id: str) -> list[dict[str, Any]]:
        results: list[dict[str, Any]] = []
        for check in self._checks:
            try:
                data = await driver.query(check["action_type"])
                results.append({"check": check["name"], "device_id": device_id, "status": "ok", "data": data})
            except Exception as exc:
                results.append({"check": check["name"], "device_id": device_id, "status": "error", "error": str(exc)})
        return results
