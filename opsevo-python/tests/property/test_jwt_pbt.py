"""Property-based tests for JWT authentication and bcrypt password hashing.

Property 8: JWT 往返一致性 — generate → verify 后 payload 一致
- generate_access_token 生成的 token 经 verify_token 解析后 sub/username 一致
- 过期 token 被拒绝
- 无效签名被拒绝
- bcrypt hash/verify 往返一致性

Validates: Requirements 5.1, 5.3, 5.5
"""

from __future__ import annotations

import time

import jwt as pyjwt
import pytest
from hypothesis import given, settings as h_settings, assume
from hypothesis import strategies as st

from opsevo.services.auth_service import AuthService
from opsevo.settings import Settings
from tests.helpers.mock_datastore import MockPgDataStore


# ── Fixtures ──────────────────────────────────────────────────────────────

def _make_auth_service(
    secret: str = "test-jwt-secret-key-for-pbt",
    access_expiry: int = 900,
    refresh_expiry: int = 604800,
) -> AuthService:
    settings = Settings(
        env="test",
        jwt_secret=secret,
        jwt_access_token_expiry=access_expiry,
        jwt_refresh_token_expiry=refresh_expiry,
    )
    return AuthService(settings=settings, datastore=MockPgDataStore())


# ── Strategies ────────────────────────────────────────────────────────────

user_ids = st.text(min_size=1, max_size=36, alphabet="abcdef0123456789-")
usernames = st.text(min_size=1, max_size=30, alphabet="abcdefghijklmnopqrstuvwxyz0123456789_")
passwords = st.text(min_size=4, max_size=20, alphabet="abcdefghijklmnopqrstuvwxyz0123456789!@#")


# ── Property: JWT roundtrip consistency ───────────────────────────────────

class TestJwtRoundtrip:
    """generate_access_token → verify_token preserves payload fields."""

    @given(user_id=user_ids, username=usernames)
    @h_settings(max_examples=30)
    def test_access_token_roundtrip(self, user_id: str, username: str):
        """Access token payload preserves sub and username after verify."""
        auth = _make_auth_service()
        token = auth.generate_access_token(user_id, username)
        payload = auth.verify_token(token)

        assert payload["sub"] == user_id
        assert payload["username"] == username
        assert payload["type"] == "access"
        assert "iat" in payload
        assert "exp" in payload

    @given(user_id=user_ids)
    @h_settings(max_examples=20)
    def test_refresh_token_roundtrip(self, user_id: str):
        """Refresh token payload preserves sub after verify."""
        auth = _make_auth_service()
        token = auth.generate_refresh_token(user_id)
        payload = auth.verify_token(token)

        assert payload["sub"] == user_id
        assert payload["type"] == "refresh"

    def test_expired_token_rejected(self):
        """Token with expiry in the past is rejected."""
        auth = _make_auth_service()
        # Craft an already-expired token manually
        expired_payload = {
            "sub": "user-1",
            "type": "access",
            "iat": int(time.time()) - 100,
            "exp": int(time.time()) - 50,
        }
        expired_token = pyjwt.encode(
            expired_payload, "test-jwt-secret-key-for-pbt", algorithm="HS256"
        )
        with pytest.raises(ValueError, match="expired"):
            auth.verify_token(expired_token)

    def test_wrong_secret_rejected(self):
        """Token signed with a different secret is rejected."""
        auth1 = _make_auth_service(secret="secret-one")
        auth2 = _make_auth_service(secret="secret-two")

        token = auth1.generate_access_token("user-1", "alice")
        with pytest.raises(ValueError, match="Invalid token"):
            auth2.verify_token(token)

    def test_tampered_token_rejected(self):
        """Modifying a token's payload invalidates it."""
        auth = _make_auth_service()
        token = auth.generate_access_token("user-1", "alice")

        # Tamper with the token by flipping a character in the payload section
        parts = token.split(".")
        assert len(parts) == 3
        # Modify payload part
        payload_bytes = list(parts[1])
        if payload_bytes:
            payload_bytes[0] = "X" if payload_bytes[0] != "X" else "Y"
        parts[1] = "".join(payload_bytes)
        tampered = ".".join(parts)

        with pytest.raises(ValueError):
            auth.verify_token(tampered)

    def test_garbage_token_rejected(self):
        """Completely invalid token string is rejected."""
        auth = _make_auth_service()
        with pytest.raises(ValueError, match="Invalid token"):
            auth.verify_token("not-a-jwt-token")

    def test_algorithm_is_hs256(self):
        """AuthService uses HS256 algorithm."""
        assert AuthService.ALGORITHM == "HS256"


# ── Property: bcrypt password roundtrip ───────────────────────────────────

class TestBcryptRoundtrip:
    """hash_password → verify_password is consistent."""

    @given(password=passwords)
    @h_settings(max_examples=5, deadline=None)
    def test_password_roundtrip(self, password: str):
        """Hashed password verifies correctly with the original."""
        hashed = AuthService.hash_password(password)
        assert AuthService.verify_password(password, hashed)

    @given(password=passwords, wrong=passwords)
    @h_settings(max_examples=5, deadline=None)
    def test_wrong_password_fails(self, password: str, wrong: str):
        """Wrong password does not verify against the hash."""
        assume(password != wrong)
        hashed = AuthService.hash_password(password)
        assert not AuthService.verify_password(wrong, hashed)

    def test_hash_is_not_plaintext(self):
        """Hash output is not the same as the input password."""
        password = "my-secret-password"
        hashed = AuthService.hash_password(password)
        assert hashed != password
        assert hashed.startswith("$2")  # bcrypt prefix
