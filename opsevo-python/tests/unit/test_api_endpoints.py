"""Unit tests for core API endpoint compatibility.

Validates URL paths, HTTP methods, response status codes, and response field
structure for auth, devices, and health endpoints.

Validates: Requirements 3.1, 3.2, 3.5
"""

from __future__ import annotations

import time
from unittest.mock import AsyncMock, MagicMock

import pytest
from httpx import ASGITransport, AsyncClient
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from opsevo.services.auth_service import AuthService
from opsevo.services.device_manager import DeviceManager
from opsevo.settings import Settings
from tests.helpers.mock_datastore import MockPgDataStore


# ── Test App Factory ──────────────────────────────────────────────────────

def _make_settings() -> Settings:
    return Settings(
        env="test",
        database_url="postgresql://test:test@localhost:5432/test",
        jwt_secret="test-jwt-secret-for-api-tests-32chars!",
    )


def _make_test_app() -> tuple[FastAPI, Settings, AuthService, MockPgDataStore]:
    """Create a FastAPI app with mock services for testing."""
    settings = _make_settings()
    ds = MockPgDataStore()
    auth = AuthService(settings=settings, datastore=ds)
    dm = DeviceManager(datastore=ds)
    pool = MagicMock()
    orchestrator = MagicMock()
    # register_device returns a coroutine
    orchestrator.register_device = AsyncMock()
    orchestrator.update_device = AsyncMock()
    orchestrator.remove_device = AsyncMock(side_effect=KeyError("not in registry"))
    orchestrator.connect_device_manual = AsyncMock(return_value=True)
    orchestrator.disconnect_device_manual = AsyncMock()

    class _Container:
        def datastore(self): return ds
        def auth_service(self): return auth
        def device_manager(self): return dm
        def device_pool(self): return pool
        def device_orchestrator(self): return orchestrator

    app = FastAPI()
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"], allow_credentials=True,
        allow_methods=["*"], allow_headers=["*"],
    )
    app.state.container = _Container()
    app.state.settings = settings

    from opsevo.api.auth import router as auth_router
    from opsevo.api.devices import router as devices_router

    app.include_router(auth_router)
    app.include_router(devices_router)

    @app.get("/api/health")
    async def health_check():
        return {"status": "ok", "timestamp": time.time(), "services": {"ready": 0, "total": 0}}

    return app, settings, auth, ds


@pytest.fixture
async def api():
    """Provide (client, auth_service, mock_datastore) tuple."""
    app, settings, auth, ds = _make_test_app()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client, auth, ds


# ── Helper ────────────────────────────────────────────────────────────────

def _auth_header(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


async def _register_and_login(client, auth, ds):
    """Register a user via mock datastore and return (token, user_id)."""
    # Seed a user directly in mock datastore
    hashed = AuthService.hash_password("testpass123")
    await ds.execute(
        "INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)",
        ("user-1", "testuser", "test@example.com", hashed),
    )
    token = auth.generate_access_token("user-1", "testuser")
    return token, "user-1"


# ── Health Endpoint ───────────────────────────────────────────────────────

class TestHealthEndpoint:

    @pytest.mark.asyncio
    async def test_health_returns_200(self, api):
        client, _, _ = api
        resp = await client.get("/api/health")
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_health_response_structure(self, api):
        client, _, _ = api
        resp = await client.get("/api/health")
        data = resp.json()
        assert "status" in data
        assert "timestamp" in data
        assert "services" in data
        assert "ready" in data["services"]
        assert "total" in data["services"]


# ── Auth Endpoints ────────────────────────────────────────────────────────

class TestAuthLogin:

    @pytest.mark.asyncio
    async def test_login_success(self, api):
        client, auth, ds = api
        # Seed user
        hashed = AuthService.hash_password("mypassword")
        await ds.execute(
            "INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)",
            ("u1", "alice", "alice@test.com", hashed),
        )
        resp = await client.post("/api/auth/login", json={
            "username": "alice", "password": "mypassword",
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["success"] is True
        assert "token" in data["data"]
        assert "refreshToken" in data["data"]
        assert data["data"]["user"]["username"] == "alice"

    @pytest.mark.asyncio
    async def test_login_invalid_credentials(self, api):
        client, _, _ = api
        resp = await client.post("/api/auth/login", json={
            "username": "nobody", "password": "wrong",
        })
        data = resp.json()
        assert data["success"] is False
        assert data["code"] == "INVALID_CREDENTIALS"

    @pytest.mark.asyncio
    async def test_login_missing_fields(self, api):
        client, _, _ = api
        resp = await client.post("/api/auth/login", json={
            "username": "", "password": "",
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["success"] is False
        assert data["code"] == "MISSING_FIELDS"


class TestAuthRegister:

    @pytest.mark.asyncio
    async def test_register_success(self, api):
        client, _, _ = api
        resp = await client.post("/api/auth/register", json={
            "username": "newuser",
            "email": "new@test.com",
            "password": "securepass",
            "invitationCode": "OpsEvo888",
        })
        assert resp.status_code == 201
        data = resp.json()
        assert data["success"] is True
        assert data["data"]["user"]["username"] == "newuser"

    @pytest.mark.asyncio
    async def test_register_bad_invitation_code(self, api):
        client, _, _ = api
        resp = await client.post("/api/auth/register", json={
            "username": "newuser",
            "email": "new@test.com",
            "password": "securepass",
            "invitationCode": "WRONG",
        })
        data = resp.json()
        assert data["success"] is False
        assert data["code"] == "INVALID_INVITATION_CODE"


class TestAuthMe:

    @pytest.mark.asyncio
    async def test_me_with_valid_token(self, api):
        client, auth, ds = api
        token, _ = await _register_and_login(client, auth, ds)
        resp = await client.get("/api/auth/me", headers=_auth_header(token))
        assert resp.status_code == 200
        data = resp.json()
        assert data["success"] is True
        assert data["data"]["username"] == "testuser"

    @pytest.mark.asyncio
    async def test_me_without_token(self, api):
        client, _, _ = api
        resp = await client.get("/api/auth/me")
        assert resp.status_code == 401


class TestAuthRefresh:

    @pytest.mark.asyncio
    async def test_refresh_success(self, api):
        client, auth, ds = api
        # Seed user
        hashed = AuthService.hash_password("pass")
        await ds.execute(
            "INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)",
            ("u1", "bob", "bob@test.com", hashed),
        )
        refresh = auth.generate_refresh_token("u1")
        resp = await client.post("/api/auth/refresh", json={
            "refreshToken": refresh,
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["success"] is True
        assert "token" in data["data"]
        assert "refreshToken" in data["data"]

    @pytest.mark.asyncio
    async def test_refresh_with_access_token_fails(self, api):
        client, auth, ds = api
        access = auth.generate_access_token("u1", "bob")
        resp = await client.post("/api/auth/refresh", json={
            "refreshToken": access,
        })
        assert resp.status_code == 401


# ── Devices Endpoints ─────────────────────────────────────────────────────

class TestDevicesEndpoints:

    @pytest.mark.asyncio
    async def test_list_devices_requires_auth(self, api):
        client, _, _ = api
        resp = await client.get("/api/devices")
        assert resp.status_code == 401

    @pytest.mark.asyncio
    async def test_list_devices_empty(self, api):
        client, auth, ds = api
        token, _ = await _register_and_login(client, auth, ds)
        resp = await client.get("/api/devices", headers=_auth_header(token))
        assert resp.status_code == 200
        data = resp.json()
        assert data["success"] is True
        assert isinstance(data["data"], list)

    @pytest.mark.asyncio
    async def test_create_device(self, api):
        client, auth, ds = api
        token, _ = await _register_and_login(client, auth, ds)
        resp = await client.post("/api/devices", headers=_auth_header(token), json={
            "name": "router-1",
            "host": "192.168.1.1",
            "port": 8728,
            "username": "admin",
            "password": "secret",
            "driver_type": "api",
        })
        assert resp.status_code == 201
        data = resp.json()
        assert data["success"] is True

    @pytest.mark.asyncio
    async def test_get_device_not_found(self, api):
        client, auth, ds = api
        token, _ = await _register_and_login(client, auth, ds)
        resp = await client.get("/api/devices/nonexistent", headers=_auth_header(token))
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_delete_device_not_found(self, api):
        client, auth, ds = api
        token, _ = await _register_and_login(client, auth, ds)
        resp = await client.delete("/api/devices/nonexistent", headers=_auth_header(token))
        assert resp.status_code == 404
