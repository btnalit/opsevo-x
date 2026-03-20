"""Bug condition exploration tests — Full-stack audit (Bugs 1.1-1.9, 1.12).

These tests encode the EXPECTED (fixed) behavior. Since the fix is already
implemented (tasks 3-9), these tests should PASS.

Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.12
"""

from __future__ import annotations

import uuid

import pytest
from httpx import ASGITransport, AsyncClient

from tests.helpers.mock_datastore import MockPgDataStore
from opsevo.services.auth_service import AuthService
from opsevo.services.state_machine.feature_flag_manager import FeatureFlagManager
from opsevo.services.ai_ops.tracing_service import TracingService


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def _settings():
    from opsevo.settings import Settings
    return Settings(
        env="test",
        database_url="postgresql://test:test@localhost:5432/test",
        jwt_secret="test-jwt-secret-exploration",
    )


@pytest.fixture
def _mock_ds():
    return MockPgDataStore()


@pytest.fixture
def _auth(_settings, _mock_ds):
    return AuthService(settings=_settings, datastore=_mock_ds)


@pytest.fixture
def _ffm(_mock_ds):
    return FeatureFlagManager(datastore=_mock_ds)


@pytest.fixture
def _ts():
    return TracingService()



@pytest.fixture
def _admin_user_row():
    return {
        "id": "admin-001",
        "username": "admin",
        "email": "admin@test.com",
        "role": "admin",
        "is_active": True,
        "password_hash": "hashed",
        "created_at": "2025-01-01T00:00:00Z",
    }


@pytest.fixture
async def _seed_admin(_mock_ds, _admin_user_row):
    """Seed the mock datastore with an admin user."""
    await _mock_ds.execute(
        "INSERT INTO users (id, username, email, role, is_active, password_hash) "
        "VALUES ($1, $2, $3, $4, $5, $6)",
        [
            _admin_user_row["id"],
            _admin_user_row["username"],
            _admin_user_row["email"],
            _admin_user_row["role"],
            _admin_user_row["is_active"],
            _admin_user_row["password_hash"],
        ],
    )


@pytest.fixture
def _auth_headers(_auth, _admin_user_row):
    token = _auth.generate_access_token(_admin_user_row["id"], _admin_user_row["username"])
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
async def _app(_settings, _mock_ds, _auth, _ffm, _ts, _seed_admin):
    """Create a FastAPI test app with all routers needed for exploration tests."""
    from unittest.mock import MagicMock
    from fastapi import FastAPI
    from fastapi.middleware.cors import CORSMiddleware

    test_app = FastAPI()
    test_app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    class _MockContainer:
        def datastore(self):
            return _mock_ds

        def auth_service(self):
            return _auth

        def feature_flag_manager(self):
            return _ffm

        def tracing_service(self):
            return _ts

        def device_orchestrator(self):
            return MagicMock()

        # Stubs for _c(request) calls in ai_ops endpoints we don't test
        def scheduler(self):
            m = MagicMock()
            m.is_running = False
            return m

        def alert_engine(self):
            return MagicMock()

        def device_pool(self):
            return MagicMock()

        def concurrency_controller(self):
            return MagicMock()

        def analysis_cache(self):
            return MagicMock()

        def batch_processor(self):
            return MagicMock()

        def fault_healer(self):
            return MagicMock()

        def autonomous_brain(self):
            return MagicMock()

        def health_monitor(self):
            return MagicMock()

    test_app.state.container = _MockContainer()
    test_app.state.settings = _settings

    from opsevo.api.auth import router as auth_router
    from opsevo.api.ai_ops import router as ai_ops_router
    from opsevo.api.prompt_templates import router as pt_router

    test_app.include_router(auth_router)
    test_app.include_router(ai_ops_router)
    test_app.include_router(pt_router)

    return test_app


@pytest.fixture
async def _client(_app):
    transport = ASGITransport(app=_app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


# ===========================================================================
# A. 端点缺失类 (Bug 1.1 - 1.7)
# ===========================================================================

class TestBug1_1_AuthUsers:
    """Bug 1.1: GET /api/auth/users should return 200 with user list.

    **Validates: Requirements 1.1, 2.1**
    """

    @pytest.mark.asyncio
    async def test_get_users_returns_200(self, _client, _auth_headers):
        resp = await _client.get("/api/auth/users", headers=_auth_headers)
        assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text}"
        body = resp.json()
        assert body["success"] is True
        assert "data" in body
        assert isinstance(body["data"], list)


class TestBug1_2_FeatureFlags:
    """Bug 1.2: GET /api/ai-ops/feature-flags should return 200.

    **Validates: Requirements 1.2, 2.2**
    """

    @pytest.mark.asyncio
    async def test_get_feature_flags_returns_200(self, _client, _auth_headers):
        resp = await _client.get("/api/ai-ops/feature-flags", headers=_auth_headers)
        assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text}"
        body = resp.json()
        assert body["success"] is True
        assert "data" in body


class TestBug1_3_Traces:
    """Bug 1.3: GET /api/ai-ops/traces should return 200.

    **Validates: Requirements 1.3, 2.3**
    """

    @pytest.mark.asyncio
    async def test_get_traces_returns_200(self, _client, _auth_headers):
        resp = await _client.get("/api/ai-ops/traces", headers=_auth_headers)
        assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text}"
        body = resp.json()
        assert body["success"] is True
        assert "data" in body


class TestBug1_4_SystemConfig:
    """Bug 1.4: GET /api/ai-ops/system/config should return 200.

    **Validates: Requirements 1.4, 2.4**
    """

    @pytest.mark.asyncio
    async def test_get_system_config_returns_200(self, _client, _auth_headers):
        resp = await _client.get("/api/ai-ops/system/config", headers=_auth_headers)
        assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text}"
        body = resp.json()
        assert body["success"] is True
        assert "data" in body
        data = body["data"]
        assert "configs" in data
        assert "envVars" in data


class TestBug1_5_PromptVersions:
    """Bug 1.5: GET /api/prompt-templates/{id}/versions should return 200.

    **Validates: Requirements 1.5, 2.5**
    """

    @pytest.mark.asyncio
    async def test_get_versions_returns_200(self, _client, _auth_headers, _mock_ds):
        tid = str(uuid.uuid4())
        # Seed a template so the endpoint has something to query
        await _mock_ds.execute(
            "INSERT INTO prompt_templates (id, name, content) VALUES ($1, $2, $3)",
            [tid, "test-tpl", "Hello {{name}}"],
        )
        resp = await _client.get(f"/api/prompt-templates/{tid}/versions", headers=_auth_headers)
        assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text}"
        body = resp.json()
        assert body["success"] is True
        assert "data" in body
        assert isinstance(body["data"], list)


class TestBug1_6_PromptRollback:
    """Bug 1.6: POST /api/prompt-templates/{id}/rollback should return 200.

    **Validates: Requirements 1.6, 2.6**
    """

    @pytest.mark.asyncio
    async def test_rollback_returns_200(self, _client, _auth_headers, _mock_ds):
        tid = str(uuid.uuid4())
        # Seed template and a version to rollback to
        await _mock_ds.execute(
            "INSERT INTO prompt_templates (id, name, content, version) VALUES ($1, $2, $3, $4)",
            [tid, "tpl-v2", "content v2", 2],
        )
        await _mock_ds.execute(
            "INSERT INTO prompt_template_versions (template_id, version, name, content) "
            "VALUES ($1, $2, $3, $4)",
            [tid, 1, "tpl-v1", "content v1"],
        )
        resp = await _client.post(
            f"/api/prompt-templates/{tid}/rollback",
            headers=_auth_headers,
            json={"version": 1},
        )
        assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text}"
        body = resp.json()
        assert body["success"] is True
        assert "data" in body


class TestBug1_7_KnowledgePrompts:
    """Bug 1.7: GET /api/ai-ops/knowledge/prompts should return 200.

    **Validates: Requirements 1.7, 2.7**
    """

    @pytest.mark.asyncio
    async def test_get_knowledge_prompts_returns_200(self, _client, _auth_headers):
        resp = await _client.get("/api/ai-ops/knowledge/prompts", headers=_auth_headers)
        assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text}"
        body = resp.json()
        assert body["success"] is True
        assert "data" in body


# ===========================================================================
# B. 参数/格式不匹配类 (Bug 1.8, 1.9)
# ===========================================================================

class TestBug1_8_HealthTrendRange:
    """Bug 1.8: GET /api/ai-ops/health/trend?range=24h should handle range param.

    **Validates: Requirements 1.8, 2.8**

    The frontend sends `range='24h'` but the old backend only accepted `hours`.
    After fix, the `range` parameter should be accepted and converted to hours.
    """

    @pytest.mark.asyncio
    async def test_range_param_accepted(self, _client, _auth_headers):
        resp = await _client.get(
            "/api/ai-ops/health/trend",
            params={"range": "24h"},
            headers=_auth_headers,
        )
        assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text}"
        body = resp.json()
        assert body["success"] is True
        assert "data" in body

    @pytest.mark.asyncio
    async def test_invalid_range_returns_400(self, _client, _auth_headers):
        resp = await _client.get(
            "/api/ai-ops/health/trend",
            params={"range": "invalid"},
            headers=_auth_headers,
        )
        assert resp.status_code == 400, f"Expected 400 for invalid range, got {resp.status_code}"


class TestBug1_9_RenderContentField:
    """Bug 1.9: POST /api/prompt-templates/{id}/render response has `data.content`.

    **Validates: Requirements 1.9, 2.9**

    The frontend expects `response.data.content` but the old backend returned
    `response.data.rendered`. After fix, both fields should be present.
    """

    @pytest.mark.asyncio
    async def test_render_has_content_field(self, _client, _auth_headers, _mock_ds):
        tid = str(uuid.uuid4())
        device_id = "dev-1"
        await _mock_ds.execute(
            "INSERT INTO prompt_templates (id, name, content, device_id) VALUES ($1, $2, $3, $4)",
            [tid, "render-tpl", "Hello {{name}}", device_id],
        )
        resp = await _client.post(
            f"/api/prompt-templates/{tid}/render",
            params={"deviceId": device_id},
            headers=_auth_headers,
            json={"name": "World"},
        )
        assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text}"
        body = resp.json()
        assert body["success"] is True
        data = body["data"]
        assert "content" in data, f"Missing 'content' field in response data: {data}"
        assert data["content"] == "Hello World"
        # Backward compat: rendered field also present
        assert "rendered" in data, f"Missing 'rendered' field (backward compat): {data}"


# ===========================================================================
# D. 查询参数忽略类 (Bug 1.12)
# ===========================================================================

class TestBug1_12_NotificationHistoryChannelId:
    """Bug 1.12: GET /api/ai-ops/notifications/history?channelId=xxx filters by channel.

    **Validates: Requirements 1.12, 2.12**

    The frontend sends `channelId` to filter notification history, but the old
    backend ignored it. After fix, channelId should be used as a filter.
    """

    @pytest.mark.asyncio
    async def test_channelid_filter_applied(self, _client, _auth_headers, _mock_ds):
        # Seed notifications with different channel_ids
        await _mock_ds.execute(
            "INSERT INTO notifications (id, channel_id, message) VALUES ($1, $2, $3)",
            ["n1", "ch-A", "msg A"],
        )
        await _mock_ds.execute(
            "INSERT INTO notifications (id, channel_id, message) VALUES ($1, $2, $3)",
            ["n2", "ch-B", "msg B"],
        )
        await _mock_ds.execute(
            "INSERT INTO notifications (id, channel_id, message) VALUES ($1, $2, $3)",
            ["n3", "ch-A", "msg A2"],
        )

        # Filter by ch-A
        resp = await _client.get(
            "/api/ai-ops/notifications/history",
            params={"channelId": "ch-A"},
            headers=_auth_headers,
        )
        assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text}"
        body = resp.json()
        assert body["success"] is True
        data = body["data"]
        # All returned rows should belong to ch-A
        for row in data:
            assert row["channel_id"] == "ch-A", (
                f"Expected channel_id='ch-A', got '{row.get('channel_id')}' — "
                "channelId filter is being ignored (Bug 1.12)"
            )
        assert len(data) == 2, f"Expected 2 rows for ch-A, got {len(data)}"
