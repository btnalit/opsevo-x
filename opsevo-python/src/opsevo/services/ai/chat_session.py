"""Chat session management service.

Requirements: 11.4
"""

from __future__ import annotations

import uuid
from typing import Any

from opsevo.data.datastore import DataStore
from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class ChatSessionService:
    def __init__(self, datastore: DataStore):
        self._ds = datastore

    async def create_session(self, device_id: str = "", title: str = "", mode: str = "general") -> dict:
        sid = str(uuid.uuid4())
        await self._ds.execute(
            "INSERT INTO chat_sessions (id, device_id, title, mode) VALUES ($1, $2, $3, $4)",
            (sid, device_id or None, title or "New Chat", mode),
        )
        return {"id": sid, "deviceId": device_id, "title": title or "New Chat", "mode": mode}

    async def get_session(self, session_id: str) -> dict | None:
        return await self._ds.query_one("SELECT * FROM chat_sessions WHERE id = $1", (session_id,))

    async def list_sessions(self, device_id: str) -> list[dict]:
        return await self._ds.query(
            "SELECT * FROM chat_sessions WHERE device_id = $1 ORDER BY updated_at DESC", (device_id,)
        )

    async def update_session(self, session_id: str, data: dict) -> dict | None:
        sets = []
        params: list[Any] = []
        idx = 1
        for k, v in data.items():
            if v is not None:
                sets.append(f"{k} = ${idx}")
                params.append(v)
                idx += 1
        if not sets:
            return await self.get_session(session_id)
        params.append(session_id)
        await self._ds.execute(
            f"UPDATE chat_sessions SET {', '.join(sets)} WHERE id = ${idx}", tuple(params)
        )
        return await self.get_session(session_id)

    async def delete_session(self, session_id: str) -> bool:
        rows = await self._ds.execute("DELETE FROM chat_sessions WHERE id = $1", (session_id,))
        return rows > 0

    async def add_message(self, session_id: str, role: str, content: str, metadata: dict | None = None) -> dict:
        mid = str(uuid.uuid4())
        await self._ds.execute(
            "INSERT INTO chat_messages (id, session_id, role, content) VALUES ($1, $2, $3, $4)",
            (mid, session_id, role, content),
        )
        return {"id": mid, "sessionId": session_id, "role": role, "content": content}

    async def get_messages(self, session_id: str, limit: int = 50) -> list[dict]:
        return await self._ds.query(
            "SELECT * FROM chat_messages WHERE session_id = $1 ORDER BY created_at ASC LIMIT $2",
            (session_id, limit),
        )
