"""FeedbackService — collect and manage alert feedback.

Requirements: 9.9
"""

from __future__ import annotations

import time
import uuid
from typing import Any

from opsevo.data.datastore import DataStore
from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class FeedbackService:
    def __init__(self, datastore: DataStore):
        self._ds = datastore

    async def submit_feedback(self, alert_id: str, feedback_type: str, comment: str = "",
                               actor: str = "system") -> str:
        fb_id = str(uuid.uuid4())
        now = int(time.time() * 1000)
        await self._ds.execute(
            "INSERT INTO alert_feedback (id, alert_id, type, comment, actor, timestamp) VALUES ($1,$2,$3,$4,$5,$6)",
            (fb_id, alert_id, feedback_type, comment, actor, now),
        )
        return fb_id

    async def get_feedback(self, alert_id: str) -> list[dict[str, Any]]:
        return await self._ds.query(
            "SELECT * FROM alert_feedback WHERE alert_id = $1 ORDER BY timestamp DESC", (alert_id,),
        )

    async def get_stats(self) -> dict[str, Any]:
        rows = await self._ds.query(
            "SELECT type, count(*) as count FROM alert_feedback GROUP BY type",
        )
        return {row["type"]: row["count"] for row in rows}
