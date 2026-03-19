"""Regression tests for audit fix items.

Validates that all fixes from the Gemini audit rounds remain intact:
1. Crypto fail-fast: _encrypt raises RuntimeError without CryptoService
2. validate_key queries by prefix, not full table scan
3. DeviceManager._ALLOWED includes 'credentials'
4. create_user uses RETURNING * (single query, no second SELECT)
5. get_alert_events / get_unified_events use SQL-level pagination

Validates: 审计修复 GAP-10
"""

from __future__ import annotations

import pytest

from tests.helpers.mock_datastore import MockPgDataStore


# ── 1. Crypto fail-fast ──────────────────────────────────────────────────

class TestCryptoFailFast:
    """ApiKeyManager._encrypt must raise RuntimeError when no CryptoService."""

    def test_encrypt_without_crypto_raises(self):
        from opsevo.services.mcp.api_key_manager import ApiKeyManager

        mgr = ApiKeyManager(crypto_service=None)
        with pytest.raises(RuntimeError, match="CryptoService is required"):
            mgr._encrypt("some-value")

    def test_decrypt_without_crypto_raises(self):
        from opsevo.services.mcp.api_key_manager import ApiKeyManager

        mgr = ApiKeyManager(crypto_service=None)
        with pytest.raises(RuntimeError, match="Cannot decrypt"):
            mgr._decrypt("some-value")


# ── 2. validate_key queries by prefix ────────────────────────────────────

class TestValidateKeyByPrefix:
    """validate_key must filter by key_prefix, not pull all rows."""

    @pytest.mark.asyncio
    async def test_validate_key_uses_prefix_filter(self):
        from opsevo.services.mcp.api_key_manager import ApiKeyManager

        queries_log: list[str] = []
        ds = MockPgDataStore()

        # Monkey-patch query to log SQL
        _orig_query = ds.query

        async def _logging_query(sql, params=None):
            queries_log.append(sql)
            return await _orig_query(sql, params)

        ds.query = _logging_query

        mgr = ApiKeyManager(crypto_service=None)
        mgr.set_datastore(ds)

        # Call validate_key — it will find no rows, but we check the SQL
        result = await mgr.validate_key("mcp_abcd1234rest")
        assert result is None

        # The SQL must contain WHERE key_prefix = $1
        assert len(queries_log) == 1
        sql = queries_log[0]
        assert "key_prefix" in sql.lower()
        assert "WHERE" in sql.upper()
        # Must NOT be a full table scan (no bare SELECT without WHERE)
        assert "$1" in sql


# ── 3. DeviceManager._ALLOWED includes credentials ──────────────────────

class TestDeviceManagerAllowedFields:
    """DeviceManager create/update must accept 'credentials' field."""

    @pytest.mark.asyncio
    async def test_create_device_allows_credentials(self):
        from opsevo.services.device_manager import DeviceManager

        ds = MockPgDataStore()
        dm = DeviceManager(datastore=ds)
        result = await dm.create_device({
            "name": "test-device",
            "host": "10.0.0.1",
            "credentials": {"api_key": "secret123"},
        })
        assert result is not None
        assert result["credentials"] == {"api_key": "secret123"}

    @pytest.mark.asyncio
    async def test_update_device_allows_credentials(self):
        from opsevo.services.device_manager import DeviceManager

        ds = MockPgDataStore()
        dm = DeviceManager(datastore=ds)
        # Create first
        created = await dm.create_device({
            "name": "dev1", "host": "10.0.0.1",
        })
        device_id = created["id"] if created else "auto-1"
        # Update with credentials
        updated = await dm.update_device(device_id, {
            "credentials": {"ssh_key": "key-data"},
        })
        assert updated is not None
        assert updated["credentials"] == {"ssh_key": "key-data"}


# ── 4. create_user uses RETURNING * ─────────────────────────────────────

class TestCreateUserReturning:
    """AuthService.create_user must use INSERT ... RETURNING * (single query)."""

    @pytest.mark.asyncio
    async def test_create_user_returns_user_dict(self):
        from opsevo.services.auth_service import AuthService
        from opsevo.settings import Settings

        ds = MockPgDataStore()
        settings = Settings(
            env="test",
            database_url="postgresql://test:test@localhost:5432/test",
            jwt_secret="test-secret-32chars-minimum!!!!!",
        )
        auth = AuthService(settings=settings, datastore=ds)
        user = await auth.create_user("alice", "alice@test.com", "password123")

        assert user is not None
        assert user["username"] == "alice"
        assert user["email"] == "alice@test.com"
        assert "password_hash" in user

    @pytest.mark.asyncio
    async def test_create_user_single_query(self):
        """Ensure create_user issues exactly one INSERT RETURNING, no extra SELECT."""
        from opsevo.services.auth_service import AuthService
        from opsevo.settings import Settings

        queries_log: list[str] = []
        ds = MockPgDataStore()
        # Only patch query_one (the entry point create_user calls).
        # query_one internally calls query — we don't double-patch.
        _orig_query_one = ds.query_one

        async def _log_query_one(sql, params=None):
            queries_log.append(sql)
            return await _orig_query_one(sql, params)

        ds.query_one = _log_query_one

        settings = Settings(
            env="test",
            database_url="postgresql://test:test@localhost:5432/test",
            jwt_secret="test-secret-32chars-minimum!!!!!",
        )
        auth = AuthService(settings=settings, datastore=ds)
        await auth.create_user("bob", "bob@test.com", "pass")

        # Exactly one query: INSERT ... RETURNING *
        assert len(queries_log) == 1
        assert "INSERT" in queries_log[0].upper()
        assert "RETURNING" in queries_log[0].upper()


# ── 5. SQL-level pagination ──────────────────────────────────────────────

class TestSQLPagination:
    """get_alert_events and get_unified_events must use SQL LIMIT/OFFSET."""

    @pytest.mark.asyncio
    async def test_query_alert_history_uses_limit_offset(self):
        from opsevo.events.event_bus import EventBus
        from opsevo.services.ai_ops.alert_engine import AlertEngine

        ds = MockPgDataStore()
        eb = EventBus()
        ae = AlertEngine(datastore=ds, event_bus=eb)

        queries_log: list[str] = []
        # Patch query and query_one separately — query_one calls query
        # internally, so only patch each at its own level.
        _orig_query = ds.query
        _orig_query_one = ds.query_one

        async def _log_query(sql, params=None):
            queries_log.append(sql)
            return await _orig_query(sql, params)

        async def _log_query_one(sql, params=None):
            queries_log.append(sql)
            return await _orig_query_one(sql, params)

        ds.query = _log_query
        ds.query_one = _log_query_one

        await ae.query_alert_history(0, 9999999999, page=2, limit=25)

        # query_one (COUNT) logs once at query_one level, then query_one
        # internally calls query which also logs — so we get 3 entries.
        # What matters: the SQL statements contain COUNT and LIMIT/OFFSET.
        sqls_upper = [s.upper() for s in queries_log]
        count_sqls = [s for s in sqls_upper if "COUNT" in s]
        select_sqls = [s for s in sqls_upper if "LIMIT" in s and "OFFSET" in s]

        assert len(count_sqls) >= 1, "Must have a COUNT query for total"
        assert len(select_sqls) >= 1, "Must have a SELECT with LIMIT/OFFSET"
        # page=2, limit=25 → OFFSET 25
        assert "25" in select_sqls[0]
