"""ConversationCollector — collects and manages starred messages.

Requirements: 11.4
"""

from __future__ import annotations

import uuid
from typing import Any

from opsevo.data.datastore import DataStore
from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class ConversationCollector:
    def __init__(self, datastore: DataStore):
        self._ds = datastore

    async def collect_message(self, message_id: str, session_id: str) -> dict:
        cid = str(uuid.uuid4())
        await self._ds.execute(
            "INSERT INTO collected_messages (id, message_id, session_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
            (cid, message_id, session_id),
        )
        return {"id": cid, "messageId": message_id}

    async def uncollect_message(self, message_id: str) -> bool:
        rows = await self._ds.execute("DELETE FROM collected_messages WHERE message_id = $1", (message_id,))
        return rows > 0

    async def get_collected(self, session_id: str) -> list[dict]:
        return await self._ds.query(
            "SELECT cm.*, m.content, m.role FROM collected_messages cm "
            "JOIN chat_messages m ON cm.message_id = m.id "
            "WHERE cm.session_id = $1 ORDER BY m.created_at ASC",
            (session_id,),
        )
