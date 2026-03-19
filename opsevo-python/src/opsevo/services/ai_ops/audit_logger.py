"""AuditLogger — structured audit logging to database.

Requirements: 9.8
"""

from __future__ import annotations

import time
import uuid
from typing import Any

from opsevo.data.datastore import DataStore
from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class AuditLogger:
    def __init__(self, datastore: DataStore):
        self._ds = datastore

    async def log(self, action: str, actor: str = "system", details: dict[str, Any] | None = None,
                  device_id: str | None = None) -> str:
        entry_id = str(uuid.uuid4())
        now = int(time.time() * 1000)
        import json
        await self._ds.execute(
            "INSERT INTO audit_logs (id, action, actor, device_id, details, timestamp) VALUES ($1,$2,$3,$4,$5,$6)",
            (entry_id, action, actor, device_id, json.dumps(details or {}, ensure_ascii=False), now),
        )
        logger.debug("audit_logged", action=action, actor=actor)
        return entry_id

    async def get_logs(self, limit: int = 50, device_id: str | None = None,
                       from_ts: int | None = None, to_ts: int | None = None) -> list[dict[str, Any]]:
        conditions = ["1=1"]
        params: list[Any] = []
        idx = 1
        if device_id:
            conditions.append(f"device_id = ${idx}")
            params.append(device_id)
            idx += 1
        if from_ts:
            conditions.append(f"timestamp >= ${idx}")
            params.append(from_ts)
            idx += 1
        if to_ts:
            conditions.append(f"timestamp <= ${idx}")
            params.append(to_ts)
            idx += 1
        params.append(limit)
        where = " AND ".join(conditions)
        return await self._ds.query(
            f"SELECT * FROM audit_logs WHERE {where} ORDER BY timestamp DESC LIMIT ${idx}",
            tuple(params),
        )
