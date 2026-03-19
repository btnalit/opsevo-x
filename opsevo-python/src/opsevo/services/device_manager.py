"""Device CRUD operations via DataStore.

Requirements: 8.5, 8.6
"""

from __future__ import annotations

from typing import Any

from opsevo.data.datastore import DataStore
from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class DeviceManager:
    """Manages device records in the database."""

    TABLE = "devices"

    def __init__(self, datastore: DataStore) -> None:
        self._ds = datastore

    async def list_devices(self, tenant_id: str | None = None) -> list[dict]:
        if tenant_id is not None:
            return await self._ds.query(
                f"SELECT * FROM {self.TABLE} WHERE tenant_id = $1",
                (tenant_id,),
            )
        return await self._ds.query(f"SELECT * FROM {self.TABLE}")

    async def get_device(self, device_id: str) -> dict | None:
        return await self._ds.query_one(
            f"SELECT * FROM {self.TABLE} WHERE id = $1", (device_id,)
        )

    async def create_device(self, data: dict[str, Any], tenant_id: str | None = None) -> dict | None:
        _ALLOWED = {
            "name", "host", "port", "username", "password",
            "driver_type", "profile_id", "use_tls",
            "status", "health_score", "metadata", "tenant_id", "credentials",
        }
        if tenant_id is not None:
            data = {**data, "tenant_id": tenant_id}
        safe = {k: v for k, v in data.items() if k in _ALLOWED}
        if not safe:
            return None
        cols = ", ".join(safe.keys())
        placeholders = ", ".join(f"${i+1}" for i in range(len(safe)))
        sql = f"INSERT INTO {self.TABLE} ({cols}) VALUES ({placeholders}) RETURNING *"
        return await self._ds.query_one(sql, tuple(safe.values()))

    async def update_device(self, device_id: str, data: dict[str, Any]) -> dict | None:
        _ALLOWED = {
            "name", "host", "port", "username", "password",
            "driver_type", "profile_id", "use_tls", "credentials",
            "status", "health_score", "metadata", "tenant_id",
        }
        safe = {k: v for k, v in data.items() if k in _ALLOWED}
        if not safe:
            return await self.get_device(device_id)
        sets = ", ".join(f"{k} = ${i+1}" for i, k in enumerate(safe.keys()))
        idx = len(safe) + 1
        sql = f"UPDATE {self.TABLE} SET {sets} WHERE id = ${idx} RETURNING *"
        return await self._ds.query_one(sql, (*safe.values(), device_id))

    async def delete_device(self, device_id: str) -> int:
        return await self._ds.execute(
            f"DELETE FROM {self.TABLE} WHERE id = $1", (device_id,)
        )
