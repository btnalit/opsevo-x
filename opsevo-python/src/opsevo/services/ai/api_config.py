"""AI API configuration management (AES-encrypted key storage).

Requirements: 11.4
"""

from __future__ import annotations

import uuid
from typing import Any

from opsevo.data.datastore import DataStore
from opsevo.utils.crypto import aes_decrypt, aes_encrypt
from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class ApiConfigService:
    def __init__(self, datastore: DataStore, secret_key: str):
        self._ds = datastore
        self._secret = secret_key

    async def list_configs(self) -> list[dict]:
        rows = await self._ds.query("SELECT * FROM ai_configs ORDER BY created_at DESC")
        return [self._sanitize(r) for r in rows]

    async def get_config(self, config_id: str) -> dict | None:
        row = await self._ds.query_one("SELECT * FROM ai_configs WHERE id = $1", (config_id,))
        return self._sanitize(row) if row else None

    async def create_config(self, data: dict) -> dict:
        cid = str(uuid.uuid4())
        encrypted_key = aes_encrypt(data.get("api_key", ""), self._secret) if data.get("api_key") else ""
        await self._ds.execute(
            "INSERT INTO ai_configs (id, name, provider, model_name, api_key_encrypted, base_url, is_default) "
            "VALUES ($1, $2, $3, $4, $5, $6, $7)",
            (cid, data["name"], data["provider"], data.get("model_name", ""),
             encrypted_key, data.get("base_url", ""), data.get("is_default", False)),
        )
        return {"id": cid, **data}

    async def update_config(self, config_id: str, data: dict) -> dict | None:
        existing = await self._ds.query_one("SELECT * FROM ai_configs WHERE id = $1", (config_id,))
        if not existing:
            return None
        if "api_key" in data and data["api_key"]:
            data["api_key_encrypted"] = aes_encrypt(data.pop("api_key"), self._secret)
        else:
            data.pop("api_key", None)
        sets, params, idx = [], [], 1
        for k, v in data.items():
            if v is not None:
                sets.append(f"{k} = ${idx}")
                params.append(v)
                idx += 1
        if sets:
            params.append(config_id)
            await self._ds.execute(
                f"UPDATE ai_configs SET {', '.join(sets)} WHERE id = ${idx}", tuple(params)
            )
        return await self.get_config(config_id)

    async def delete_config(self, config_id: str) -> bool:
        return (await self._ds.execute("DELETE FROM ai_configs WHERE id = $1", (config_id,))) > 0

    async def get_default_config(self) -> dict | None:
        row = await self._ds.query_one("SELECT * FROM ai_configs WHERE is_default = true LIMIT 1")
        return self._sanitize(row) if row else None

    async def get_decrypted_key(self, config_id: str) -> str:
        row = await self._ds.query_one("SELECT api_key_encrypted FROM ai_configs WHERE id = $1", (config_id,))
        if not row or not row.get("api_key_encrypted"):
            return ""
        return aes_decrypt(row["api_key_encrypted"], self._secret)

    @staticmethod
    def _sanitize(row: dict | None) -> dict:
        if not row:
            return {}
        r = dict(row)
        r.pop("api_key_encrypted", None)
        return r
