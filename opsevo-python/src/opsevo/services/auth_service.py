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
        return bcrypt.checkpw(password.encode("utf-8"), hashed.encode("utf-8"))

    async def authenticate(self, username: str, password: str) -> dict | None:
        user = await self._ds.query_one(
            "SELECT * FROM users WHERE username = $1", (username,)
        )
        if not user:
            return None
        if not self.verify_password(password, user.get("password_hash", "")):
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
