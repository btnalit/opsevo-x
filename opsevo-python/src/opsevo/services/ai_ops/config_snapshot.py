"""ConfigSnapshot — device config backup using CapabilityManifest (device-agnostic).

Requirements: 9.2, 1.7, 1.10
"""

from __future__ import annotations

import time
import uuid
from typing import Any

from opsevo.data.datastore import DataStore
from opsevo.drivers.base import DeviceDriver
from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class ConfigSnapshotService:
    def __init__(self, datastore: DataStore):
        self._ds = datastore

    async def export_config(self, driver: DeviceDriver, device_id: str) -> dict[str, Any]:
        manifest = driver.get_capability_manifest()
        config_paths = manifest.config_paths
        parts: dict[str, Any] = {}
        for action_type in config_paths:
            try:
                data = await driver.query(action_type)
                parts[action_type] = data
            except Exception:
                logger.warning("config_export_part_failed", action_type=action_type)
                parts[action_type] = None
        snapshot_id = str(uuid.uuid4())
        now = int(time.time() * 1000)
        import json
        await self._ds.execute(
            "INSERT INTO config_snapshots (id, device_id, data, timestamp) VALUES ($1,$2,$3,$4)",
            (snapshot_id, device_id, json.dumps(parts, ensure_ascii=False, default=str), now),
        )
        logger.info("config_snapshot_created", id=snapshot_id, device_id=device_id, parts=len(parts))
        return {"id": snapshot_id, "device_id": device_id, "parts": list(parts.keys()), "timestamp": now}

    async def get_snapshots(self, device_id: str, limit: int = 10) -> list[dict[str, Any]]:
        return await self._ds.query(
            "SELECT id, device_id, timestamp FROM config_snapshots WHERE device_id = $1 ORDER BY timestamp DESC LIMIT $2",
            (device_id, limit),
        )

    async def get_snapshot(self, snapshot_id: str) -> dict[str, Any] | None:
        return await self._ds.query_one("SELECT * FROM config_snapshots WHERE id = $1", (snapshot_id,))

    async def diff_snapshots(self, id_a: str, id_b: str) -> dict[str, Any]:
        a = await self.get_snapshot(id_a)
        b = await self.get_snapshot(id_b)
        if not a or not b:
            return {"error": "Snapshot not found"}
        import json
        data_a = json.loads(a.get("data", "{}"))
        data_b = json.loads(b.get("data", "{}"))
        changes: dict[str, str] = {}
        all_keys = set(data_a.keys()) | set(data_b.keys())
        for key in all_keys:
            va, vb = data_a.get(key), data_b.get(key)
            if va != vb:
                changes[key] = "modified" if va and vb else ("added" if vb else "removed")
        return {"snapshot_a": id_a, "snapshot_b": id_b, "changes": changes}
