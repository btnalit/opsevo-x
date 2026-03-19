"""InspectionHandler — handle scheduled device inspections.

Requirements: 9.10
"""

from __future__ import annotations

from typing import Any

from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class InspectionHandler:
    def __init__(self) -> None:
        self._results: list[dict[str, Any]] = []

    async def handle(self, device_id: str, driver: Any, checks: list[str] | None = None) -> dict[str, Any]:
        results: dict[str, Any] = {"device_id": device_id, "checks": {}}
        for check in checks or ["health", "metrics"]:
            try:
                if check == "health":
                    r = await driver.health_check()
                    results["checks"]["health"] = {"healthy": getattr(r, "healthy", True)}
                elif check == "metrics":
                    m = await driver.collect_metrics()
                    results["checks"]["metrics"] = {"cpu": getattr(m, "cpu_usage", 0), "memory": getattr(m, "memory_usage", 0)}
                else:
                    data = await driver.query(check)
                    results["checks"][check] = {"data": data}
            except Exception as exc:
                results["checks"][check] = {"error": str(exc)}
        self._results.append(results)
        return results

    def get_recent(self, limit: int = 20) -> list[dict[str, Any]]:
        return self._results[-limit:]
