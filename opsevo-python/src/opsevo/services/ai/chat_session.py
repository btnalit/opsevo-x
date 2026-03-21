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

    async def create_session(
        self,
        device_id: str = "",
        title: str = "",
        mode: str = "general",
        user_id: str = "",
    ) -> dict:
        sid = str(uuid.uuid4())
        await self._ds.execute(
            "INSERT INTO chat_sessions (id, user_id, device_id, title, mode) VALUES ($1, $2, $3, $4, $5)",
            (sid, user_id or None, device_id or None, title or "New Chat", mode),
        )
        return {
            "id": sid,
            "userId": user_id or "",
            "deviceId": device_id,
            "title": title or "New Chat",
            "mode": mode,
        }

    async def get_session(self, session_id: str, user_id: str | None = None) -> dict | None:
        if user_id is None:
            return await self._ds.query_one("SELECT * FROM chat_sessions WHERE id = $1", (session_id,))
        return await self._ds.query_one(
            "SELECT * FROM chat_sessions WHERE id = $1 AND user_id = $2",
            (session_id, user_id),
        )

    async def list_sessions(self, device_id: str = "", user_id: str | None = None) -> list[dict]:
        where = []
        params: list[Any] = []
        idx = 1
        if user_id is not None:
            where.append(f"user_id = ${idx}")
            params.append(user_id)
            idx += 1
        if device_id:
            where.append(f"device_id = ${idx}")
            params.append(device_id)
        sql = "SELECT * FROM chat_sessions"
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY updated_at DESC"
        return await self._ds.query(sql, tuple(params))

    async def update_session(self, session_id: str, data: dict, user_id: str | None = None) -> dict | None:
        sets = []
        params: list[Any] = []
        idx = 1
        for k, v in data.items():
            if v is not None:
                sets.append(f"{k} = ${idx}")
                params.append(v)
                idx += 1
        if not sets:
            return await self.get_session(session_id, user_id=user_id)
        params.append(session_id)
        where = f"id = ${idx}"
        if user_id is not None:
            idx += 1
            params.append(user_id)
            where += f" AND user_id = ${idx}"
        await self._ds.execute(
            f"UPDATE chat_sessions SET {', '.join(sets)} WHERE {where}",
            tuple(params),
        )
        return await self.get_session(session_id, user_id=user_id)

    async def delete_session(self, session_id: str, user_id: str | None = None) -> bool:
        if user_id is None:
            rows = await self._ds.execute("DELETE FROM chat_sessions WHERE id = $1", (session_id,))
        else:
            rows = await self._ds.execute(
                "DELETE FROM chat_sessions WHERE id = $1 AND user_id = $2",
                (session_id, user_id),
            )
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
