"""
ApiKeyManager — MCP Server API Key CRUD + 加密存储

管理 MCP Server 的 API Key 生命周期：创建、验证、撤销、列表。
使用 CryptoService (AES-256) 加密存储，asyncio.Lock 防止并发竞态。
"""

from __future__ import annotations

import asyncio
import hmac
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import structlog

logger = structlog.get_logger(__name__)


@dataclass
class McpApiKey:
    """MCP API Key 元数据。"""

    id: str
    key_hash: str
    key_prefix: str
    tenant_id: str
    role: str  # admin | operator | viewer
    label: str
    status: str  # active | revoked
    created_at: str  # ISO 8601 timestamp
    revoked_at: str | None = None


@dataclass
class SecurityContext:
    """安全上下文。"""

    tenant_id: str
    role: str
    api_key_id: str
    client_id: str | None = None


class ApiKeyManager:
    """MCP API Key 管理器。"""

    def __init__(self, crypto_service: Any = None) -> None:
        self._crypto = crypto_service
        self._datastore: Any = None
        self._lock = asyncio.Lock()

    def set_datastore(self, datastore: Any) -> None:
        self._datastore = datastore
        logger.info("ApiKeyManager: DataStore injected")

    # ------------------------------------------------------------------
    # 读取
    # ------------------------------------------------------------------

    async def _read_keys(self) -> list[McpApiKey]:
        if not self._datastore:
            return []
        rows = await self._datastore.query(
            "SELECT id, key_hash, key_prefix, tenant_id, role, label, status, created_at, revoked_at "
            "FROM mcp_api_keys"
        )
        return [
            McpApiKey(
                id=r["id"],
                key_hash=r["key_hash"],
                key_prefix=r["key_prefix"],
                tenant_id=r["tenant_id"],
                role=r["role"],
                label=r["label"],
                status=r["status"],
                created_at=r["created_at"],
                revoked_at=r.get("revoked_at"),
            )
            for r in rows
        ]

    # ------------------------------------------------------------------
    # CRUD
    # ------------------------------------------------------------------

    async def create_key(
        self, tenant_id: str, role: str, label: str
    ) -> dict[str, Any]:
        """创建新 API Key，返回明文 key（仅此一次）和元数据。"""
        if not self._datastore:
            raise RuntimeError("ApiKeyManager: DataStore not configured")

        async with self._lock:
            raw_key = f"mcp_{uuid.uuid4().hex}"
            key_prefix = raw_key[:8]
            key_hash = self._encrypt(raw_key)
            key_id = str(uuid.uuid4())
            now = datetime.now(timezone.utc)

            await self._datastore.execute(
                "INSERT INTO mcp_api_keys (id, key_hash, key_prefix, tenant_id, role, label, status, created_at) "
                "VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
                [key_id, key_hash, key_prefix, tenant_id, role, label, "active", now],
            )
            logger.info("API Key created", id=key_id, tenant=tenant_id, role=role)
            return {
                "key": raw_key,
                "metadata": {
                    "id": key_id,
                    "keyPrefix": key_prefix,
                    "tenantId": tenant_id,
                    "role": role,
                    "label": label,
                    "status": "active",
                    "createdAt": now.isoformat(),
                },
            }

    async def revoke_key(self, key_id: str) -> None:
        if not self._datastore:
            raise RuntimeError("ApiKeyManager: DataStore not configured")
        async with self._lock:
            row = await self._datastore.query_one(
                "SELECT id, status FROM mcp_api_keys WHERE id = $1", [key_id]
            )
            if not row:
                raise ValueError(f"API Key not found: {key_id}")
            if row["status"] == "revoked":
                return
            await self._datastore.execute(
                "UPDATE mcp_api_keys SET status = $1, revoked_at = $2 WHERE id = $3",
                ["revoked", datetime.now(timezone.utc), key_id],
            )
            logger.info("API Key revoked", id=key_id)

    async def list_keys(self) -> list[dict[str, Any]]:
        keys = await self._read_keys()
        return [
            {
                "id": k.id,
                "keyPrefix": k.key_prefix,
                "tenantId": k.tenant_id,
                "role": k.role,
                "label": k.label,
                "status": k.status,
                "createdAt": k.created_at,
                "revokedAt": k.revoked_at,
            }
            for k in keys
        ]

    async def validate_key(self, raw_key: str) -> SecurityContext | None:
        """验证 API Key，返回 SecurityContext 或 None。"""
        if not raw_key or not self._datastore:
            return None
        prefix = raw_key[:8]
        rows = await self._datastore.query(
            "SELECT id, key_hash, tenant_id, role FROM mcp_api_keys "
            "WHERE key_prefix = $1 AND status = 'active'",
            [prefix],
        )
        for r in rows:
            try:
                decrypted = self._decrypt(r["key_hash"])
                if hmac.compare_digest(raw_key, decrypted):
                    return SecurityContext(
                        tenant_id=r["tenant_id"],
                        role=r["role"],
                        api_key_id=r["id"],
                    )
            except Exception:
                logger.warning("validate_key_decrypt_failed", key_id=r["id"], exc_info=True)
                continue
        return None

    # ------------------------------------------------------------------
    # 加密辅助
    # ------------------------------------------------------------------

    def _encrypt(self, value: str) -> str:
        if self._crypto:
            return self._crypto.encrypt(value)
        raise RuntimeError(
            "CryptoService is required to create API keys. "
            "SHA256 fallback removed because one-way hash makes keys unvalidatable."
        )

    def _decrypt(self, value: str) -> str:
        if self._crypto:
            return self._crypto.decrypt(value)
        raise RuntimeError("Cannot decrypt without CryptoService")
