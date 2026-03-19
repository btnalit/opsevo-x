"""SnapshotHandler — handle scheduled config snapshots.

Requirements: 9.10
"""

from __future__ import annotations

from typing import Any

from opsevo.services.ai_ops.config_snapshot import ConfigSnapshotService
from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class SnapshotHandler:
    def __init__(self, snapshot_service: ConfigSnapshotService):
        self._snapshot_svc = snapshot_service

    async def handle(self, device_id: str, driver: Any) -> dict[str, Any]:
        try:
            result = await self._snapshot_svc.export_config(driver, device_id)
            logger.info("snapshot_handler_completed", device_id=device_id)
            return result
        except Exception as exc:
            logger.error("snapshot_handler_failed", device_id=device_id, error=str(exc))
            return {"device_id": device_id, "error": str(exc)}
