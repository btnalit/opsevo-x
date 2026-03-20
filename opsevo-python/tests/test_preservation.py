"""Preservation property tests — Existing endpoint behaviors MUST remain working.

These tests verify that existing (pre-fix) endpoint behaviors are preserved
after the full-stack audit bugfix. They use hypothesis for property-based
testing where appropriate (random valid inputs) and standard pytest for
concrete endpoint checks.

**Validates: Requirements 3.1, 3.6, 3.8, 3.11, 3.12**

Properties tested:
1. Auth endpoints (login/register/refresh/me) return expected format (Req 3.1)
2. Prompt template CRUD endpoints return expected format (Req 3.6)
3. Health/trend with `hours` param returns data — backward compat (Req 3.8)
4. Render response still contains `rendered` field — backward compat (Req 3.6)
"""

from __future__ import annotations

import uuid

import pytest
from hypothesis import given, settings, HealthCheck
from hypothesis import strategies as st
from httpx import ASGITransport, AsyncClient
from unittest.mock import MagicMock

from tests.helpers.mock_datastore import MockPgDataStore
from opsevo.services.auth_service import AuthService
from opsevo.services.state_machine.feature_flag_manager import FeatureFlagManager
from opsevo.services.ai_ops.tracing_service import TracingService


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

INVITATION_CODE = "OpsEvo888"


@pytest.fixture
def _settings():
    from opsevo.settings import Settings
    return Settings(
        env="test",
        database_url="postgresql://test:test@localhost:5432/test",
        jwt_secret="test-jwt-secret-preservation",
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
        "id": "admin-pres-001",
        "username": "admin_pres",
        "email": "admin_pres@test.com",
        "role": "admin",
        "is_active": True,
        "password_hash": AuthService.hash_password("admin-pass-123"),
        "created_at": "2025-01-01T00:00:00Z",
    }


@pytest.fixture
async def _seed_admin(_mock_ds, _admin_user_row):
    """Seed the mock datastore with an admin user."""
    row = _admin_user_row
    await _mock_ds.execute(
        "INSERT INTO users (id, username, email, role, is_active, password_hash) "
        "VALUES ($1, $2, $3, $4, $5, $6)",
        [row["id"], row["username"], row["email"], row["role"], row["is_active"], row["password_hash"]],
    )


@pytest.fixture
def _auth_headers(_auth, _admin_user_row):
    token = _auth.generate_access_token(_admin_user_row["id"], _admin_user_row["username"])
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
async def _app(_settings, _mock_ds, _auth, _ffm, _ts, _seed_admin):
    """Create a FastAPI test app with all routers needed for preservation tests."""
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
# 1. Auth endpoint preservation (Req 3.1)
# ===========================================================================

class TestAuthLoginPreservation:
    """POST /api/auth/login with valid credentials returns token.

    **Validates: Requirements 3.1**
    """

    @pytest.mark.asyncio
    async def test_login_returns_token(self, _client, _admin_user_row):
        resp = await _client.post("/api/auth/login", json={
            "username": _admin_user_row["username"],
            "password": "admin-pass-123",
        })
        assert resp.status_code == 200, f"Login failed: {resp.text}"
        body = resp.json()
        assert body["success"] is True
        assert "data" in body
        data = body["data"]
        assert "token" in data
        assert len(data["token"]) > 0
        assert "user" in data
        assert data["user"]["username"] == _admin_user_row["username"]


class TestAuthRegisterPreservation:
    """POST /api/auth/register creates user and returns token.

    **Validates: Requirements 3.1**
    """

    @pytest.mark.asyncio
    @given(
        username=st.text(
            alphabet=st.characters(whitelist_categories=("Ll", "Lu", "Nd")),
            min_size=3, max_size=20,
        ).filter(lambda s: s.isalnum()),
    )
    @settings(max_examples=5, deadline=None, suppress_health_check=[HealthCheck.function_scoped_fixture])
    async def test_register_creates_user(self, _client, username):
        email = f"{username}@test-pres.com"
        resp = await _client.post("/api/auth/register", json={
            "username": username,
            "email": email,
            "password": "TestPass123!",
            "invitationCode": INVITATION_CODE,
        })
        assert resp.status_code == 201, f"Register failed: {resp.text}"
        body = resp.json()
        assert body["success"] is True
        assert "data" in body
        assert "user" in body["data"]
        assert body["data"]["user"]["username"] == username


class TestAuthRefreshPreservation:
    """POST /api/auth/refresh with valid refresh token returns new token.

    **Validates: Requirements 3.1**
    """

    @pytest.mark.asyncio
    async def test_refresh_returns_new_token(self, _client, _auth, _admin_user_row):
        refresh_token = _auth.generate_refresh_token(_admin_user_row["id"])
        resp = await _client.post("/api/auth/refresh", json={
            "refreshToken": refresh_token,
        })
        assert resp.status_code == 200, f"Refresh failed: {resp.text}"
        body = resp.json()
        assert body["success"] is True
        assert "data" in body
        data = body["data"]
        assert "token" in data
        assert len(data["token"]) > 0


class TestAuthMePreservation:
    """GET /api/auth/me with valid JWT returns user info.

    **Validates: Requirements 3.1**
    """

    @pytest.mark.asyncio
    async def test_me_returns_user_info(self, _client, _auth_headers, _admin_user_row):
        resp = await _client.get("/api/auth/me", headers=_auth_headers)
        assert resp.status_code == 200, f"Me failed: {resp.text}"
        body = resp.json()
        assert body["success"] is True
        assert "data" in body
        data = body["data"]
        assert data["username"] == _admin_user_row["username"]
        assert "id" in data


# ===========================================================================
# 2. Prompt template CRUD preservation (Req 3.6)
# ===========================================================================

class TestPromptTemplateListPreservation:
    """GET /api/prompt-templates returns template list.

    **Validates: Requirements 3.6**
    """

    @pytest.mark.asyncio
    async def test_get_templates_returns_list(self, _client, _auth_headers):
        resp = await _client.get("/api/prompt-templates", headers=_auth_headers)
        assert resp.status_code == 200, f"Get templates failed: {resp.text}"
        body = resp.json()
        assert body["success"] is True
        assert "data" in body
        assert isinstance(body["data"], list)


class TestPromptTemplateCreatePreservation:
    """POST /api/prompt-templates creates template.

    **Validates: Requirements 3.6**
    """

    @pytest.mark.asyncio
    @given(
        name=st.text(
            alphabet=st.characters(whitelist_categories=("Ll", "Lu", "Nd")),
            min_size=1, max_size=30,
        ).filter(lambda s: len(s.strip()) > 0),
        content=st.text(min_size=1, max_size=200).filter(lambda s: len(s.strip()) > 0),
    )
    @settings(max_examples=5, suppress_health_check=[HealthCheck.function_scoped_fixture])
    async def test_create_template_returns_data(self, _client, _auth_headers, name, content):
        resp = await _client.post(
            "/api/prompt-templates",
            headers=_auth_headers,
            json={"name": name, "content": content},
        )
        assert resp.status_code == 200, f"Create template failed: {resp.text}"
        body = resp.json()
        assert body["success"] is True
        assert "data" in body
        assert body["data"]["name"] == name


class TestPromptTemplateGetByIdPreservation:
    """GET /api/prompt-templates/{id} returns single template.

    **Validates: Requirements 3.6**
    """

    @pytest.mark.asyncio
    async def test_get_template_by_id(self, _client, _auth_headers, _mock_ds):
        tid = str(uuid.uuid4())
        device_id = "dev-pres"
        await _mock_ds.execute(
            "INSERT INTO prompt_templates (id, device_id, name, content) VALUES ($1, $2, $3, $4)",
            [tid, device_id, "pres-tpl", "Hello {{name}}"],
        )
        resp = await _client.get(
            f"/api/prompt-templates/{tid}",
            params={"deviceId": device_id},
            headers=_auth_headers,
        )
        assert resp.status_code == 200, f"Get template by id failed: {resp.text}"
        body = resp.json()
        assert body["success"] is True
        assert "data" in body
        assert body["data"]["id"] == tid
        assert body["data"]["name"] == "pres-tpl"


# ===========================================================================
# 3. Health/trend backward compat with `hours` param (Req 3.8)
# ===========================================================================

class TestHealthTrendHoursPreservation:
    """GET /api/ai-ops/health/trend?hours=N returns trend data with hours param.

    **Validates: Requirements 3.8**

    The `hours` integer parameter is the original API contract. After the fix
    added `range` support, the `hours` param must still work identically.
    """

    @pytest.mark.asyncio
    @given(hours=st.integers(min_value=1, max_value=720))
    @settings(max_examples=10, suppress_health_check=[HealthCheck.function_scoped_fixture])
    async def test_hours_param_returns_200(self, _client, _auth_headers, hours):
        resp = await _client.get(
            "/api/ai-ops/health/trend",
            params={"hours": hours},
            headers=_auth_headers,
        )
        assert resp.status_code == 200, (
            f"health/trend?hours={hours} returned {resp.status_code}: {resp.text}"
        )
        body = resp.json()
        assert body["success"] is True
        assert "data" in body
        assert isinstance(body["data"], list)


# ===========================================================================
# 4. Render response backward compat — `rendered` field (Req 3.6)
# ===========================================================================

class TestRenderRenderedFieldPreservation:
    """POST /api/prompt-templates/{id}/render response still contains `rendered`.

    **Validates: Requirements 3.6**

    After the fix added the `content` field, the original `rendered` field
    must still be present for backward compatibility.
    """

    @pytest.mark.asyncio
    @given(
        var_value=st.text(
            alphabet=st.characters(whitelist_categories=("Ll", "Lu", "Nd", "Zs")),
            min_size=1, max_size=50,
        ).filter(lambda s: len(s.strip()) > 0),
    )
    @settings(max_examples=5, suppress_health_check=[HealthCheck.function_scoped_fixture])
    async def test_render_contains_rendered_field(
        self, _client, _auth_headers, _mock_ds, var_value,
    ):
        tid = str(uuid.uuid4())
        device_id = "dev-render-pres"
        await _mock_ds.execute(
            "INSERT INTO prompt_templates (id, device_id, name, content) VALUES ($1, $2, $3, $4)",
            [tid, device_id, "render-pres", "Hello {{name}}"],
        )
        resp = await _client.post(
            f"/api/prompt-templates/{tid}/render",
            params={"deviceId": device_id},
            headers=_auth_headers,
            json={"name": var_value},
        )
        assert resp.status_code == 200, f"Render failed: {resp.text}"
        body = resp.json()
        assert body["success"] is True
        data = body["data"]
        # Backward compat: `rendered` field MUST still be present
        assert "rendered" in data, f"Missing 'rendered' field (backward compat): {data}"
        assert data["rendered"] == f"Hello {var_value}"
        # New field: `content` should also be present
        assert "content" in data, f"Missing 'content' field: {data}"
        assert data["content"] == data["rendered"]
