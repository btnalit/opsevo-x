"""Shared test fixtures for the Opsevo test suite.

Requirements: 23.1, 23.3, 23.4
"""

import pytest
from httpx import ASGITransport, AsyncClient

from tests.helpers.mock_datastore import MockPgDataStore


@pytest.fixture
def settings():
    """Provide a Settings instance with test defaults."""
    from opsevo.settings import Settings

    return Settings(
        env="test",
        database_url="postgresql://test:test@localhost:5432/opsevo_test",
        jwt_secret="test-jwt-secret",
        ai_provider="gemini",
    )


@pytest.fixture
def mock_datastore():
    """Provide a fresh in-memory MockPgDataStore."""
    return MockPgDataStore()


@pytest.fixture
def auth_service(settings, mock_datastore):
    """Provide an AuthService wired to mock datastore."""
    from opsevo.services.auth_service import AuthService

    return AuthService(settings=settings, datastore=mock_datastore)


@pytest.fixture
def auth_token(auth_service):
    """Generate a valid JWT for test requests."""
    return auth_service.generate_access_token("test-user-id", "testuser")


@pytest.fixture
async def app(settings, mock_datastore, auth_service):
    """Create a FastAPI app with mock services for integration tests."""
    import time
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

    # Wire a minimal mock container
    class _MockContainer:
        def datastore(self):
            return mock_datastore

        def auth_service(self):
            return auth_service

    test_app.state.container = _MockContainer()
    test_app.state.settings = settings

    # Register routers
    from opsevo.api.auth import router as auth_router
    from opsevo.api.system import router as system_router
    from opsevo.api.devices import router as devices_router

    test_app.include_router(auth_router)
    test_app.include_router(system_router)
    test_app.include_router(devices_router)

    @test_app.get("/api/health")
    async def health_check():
        return {"status": "ok", "timestamp": time.time(), "services": {"ready": 0, "total": 0}}

    return test_app


@pytest.fixture
async def client(app):
    """Provide an async HTTP client for testing FastAPI endpoints."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
