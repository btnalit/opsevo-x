"""JWT authentication service.

Requirements: 5.1, 5.3, 5.5
"""

from __future__ import annotations

import time
from typing import Any

import bcrypt
import jwt

from opsevo.data.datastore import DataStore
from opsevo.settings import Settings
from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class AuthService:
    """JWT token generation/verification and password hashing."""

    ALGORITHM = "HS256"

    def __init__(self, settings: Settings, datastore: DataStore) -> None:
        self._secret = settings.jwt_secret
        self._access_expiry = settings.jwt_access_token_expiry
        self._refresh_expiry = settings.jwt_refresh_token_expiry
        self._ds = datastore

    def generate_token(self, payload: dict[str, Any], expiry: int | None = None) -> str:
        exp = expiry or self._access_expiry
        data = {**payload, "iat": int(time.time()), "exp": int(time.time()) + exp}
        return jwt.encode(data, self._secret, algorithm=self.ALGORITHM)

    def verify_token(self, token: str) -> dict[str, Any]:
        try:
            return jwt.decode(token, self._secret, algorithms=[self.ALGORITHM])
        except jwt.ExpiredSignatureError:
            raise ValueError("Token expired")
        except jwt.InvalidTokenError as e:
            raise ValueError(f"Invalid token: {e}")

    def generate_access_token(self, user_id: str, username: str) -> str:
        return self.generate_token(
            {"sub": user_id, "username": username, "type": "access"},
            self._access_expiry,
        )

    def generate_refresh_token(self, user_id: str) -> str:
        return self.generate_token(
            {"sub": user_id, "type": "refresh"},
            self._refresh_expiry,
        )

    @staticmethod
    def hash_password(password: str) -> str:
        return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")

    @staticmethod
    def verify_password(password: str, hashed: str) -> bool:
        if not hashed:
            return False
        try:
            return bcrypt.checkpw(password.encode("utf-8"), hashed.encode("utf-8"))
        except (ValueError, TypeError):
            return False

    async def authenticate(self, username: str, password: str) -> dict | None:
        user = await self._ds.query_one(
            "SELECT * FROM users WHERE username = $1", (username,)
        )
        if not user:
            return None
        if not self.verify_password(password, user.get("password_hash") or ""):
            return None
        return user

    async def create_user(self, username: str, email: str, password: str) -> dict:
        """Create a new user: hash password, insert, and return user dict."""
        hashed = self.hash_password(password)
        user = await self._ds.query_one(
            "INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING *",
            (username, email, hashed),
        )
        return user

    async def get_user_by_id(self, user_id: str) -> dict | None:
        return await self._ds.query_one(
            "SELECT * FROM users WHERE id = $1", (user_id,)
        )

    # ── User Management (full-stack-audit) ────────────────────────────

    async def list_users(
        self, limit: int = 100, offset: int = 0, include_inactive: bool = False,
    ) -> list[dict]:
        if include_inactive:
            rows = await self._ds.query(
                "SELECT id, username, email, role, is_active, created_at "
                "FROM users ORDER BY created_at DESC LIMIT $1 OFFSET $2",
                (limit, offset),
            )
        else:
            rows = await self._ds.query(
                "SELECT id, username, email, role, is_active, created_at "
                "FROM users WHERE is_active = TRUE ORDER BY created_at DESC LIMIT $1 OFFSET $2",
                (limit, offset),
            )
        return rows

    async def update_user(self, user_id: str, data: dict) -> dict | None:
        allowed = {"username", "email", "role"}
        sets, params, idx = [], [], 1
        for k in allowed:
            if k in data and data[k] is not None:
                sets.append(f"{k} = ${idx}")
                params.append(data[k])
                idx += 1
        if not sets:
            return await self.get_user_by_id(user_id)
        params.append(user_id)
        update_sql = f"UPDATE users SET {', '.join(sets)}, updated_at = NOW() WHERE id = ${idx}"

        # 如果涉及角色降级，使用事务+行锁保证原子性，防止 TOCTOU 竞态
        new_role = data.get("role")
        if new_role and new_role != "admin":
            async def _tx(tx):
                target = await tx.query_one(
                    "SELECT role FROM users WHERE id = $1 FOR UPDATE", (user_id,)
                )
                if not target:
                    return
                if target.get("role") == "admin":
                    row = await tx.query_one(
                        "SELECT COUNT(*) as cnt FROM users WHERE role = 'admin' AND is_active = TRUE AND id != $1",
                        (user_id,),
                    )
                    if int(row["cnt"]) == 0:
                        raise ValueError("Cannot demote the last admin")
                try:
                    await tx.execute(update_sql, tuple(params))
                except Exception as exc:
                    if "unique" in str(exc).lower() or "duplicate" in str(exc).lower():
                        raise ValueError("Username or email already exists")
                    raise
            await self._ds.transaction(_tx)
        else:
            try:
                await self._ds.execute(update_sql, tuple(params))
            except Exception as exc:
                if "unique" in str(exc).lower() or "duplicate" in str(exc).lower():
                    raise ValueError("Username or email already exists")
                raise
        return await self.get_user_by_id(user_id)

    async def reset_password(self, user_id: str, new_password: str) -> None:
        hashed = self.hash_password(new_password)
        await self._ds.execute(
            "UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2",
            (hashed, user_id),
        )

    async def delete_user(self, user_id: str) -> None:
        """软删除：设置 is_active = FALSE。使用事务+行锁防止最后管理员被删除的 TOCTOU 竞态。"""
        async def _tx(tx):
            target = await tx.query_one(
                "SELECT role FROM users WHERE id = $1 FOR UPDATE", (user_id,)
            )
            if not target:
                return
            if target.get("role") == "admin":
                row = await tx.query_one(
                    "SELECT COUNT(*) as cnt FROM users WHERE role = 'admin' AND is_active = TRUE AND id != $1",
                    (user_id,),
                )
                if int(row["cnt"]) == 0:
                    raise ValueError("Cannot delete the last admin")
            await tx.execute(
                "UPDATE users SET is_active = FALSE, updated_at = NOW() WHERE id = $1",
                (user_id,),
            )
        await self._ds.transaction(_tx)

    async def restore_user(self, user_id: str) -> dict | None:
        """恢复软删除用户，恢复前检查 username/email 冲突。"""
        user = await self._ds.query_one("SELECT * FROM users WHERE id = $1", (user_id,))
        if not user:
            return None
        # 检查 username/email 是否已被其他活跃用户占用
        conflict = await self._ds.query_one(
            "SELECT id FROM users WHERE (username = $1 OR email = $2) AND is_active = TRUE AND id != $3",
            (user["username"], user.get("email"), user_id),
        )
        if conflict:
            raise ValueError("Username or email already taken by an active user")
        try:
            await self._ds.execute(
                "UPDATE users SET is_active = TRUE, updated_at = NOW() WHERE id = $1",
                (user_id,),
            )
        except Exception as exc:
            # DB unique constraint violation (TOCTOU race on username/email)
            if "unique" in str(exc).lower() or "duplicate" in str(exc).lower():
                raise ValueError("Username or email already taken by an active user")
            raise
        return await self.get_user_by_id(user_id)

    async def count_active_admins(self, exclude_user_id: str | None = None) -> int:
        if exclude_user_id:
            row = await self._ds.query_one(
                "SELECT COUNT(*) as cnt FROM users WHERE role = 'admin' AND is_active = TRUE AND id != $1",
                (exclude_user_id,),
            )
        else:
            row = await self._ds.query_one(
                "SELECT COUNT(*) as cnt FROM users WHERE role = 'admin' AND is_active = TRUE",
                (),
            )
        return int(row["cnt"]) if row else 0
