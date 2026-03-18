"""Tests for health check endpoint and internal API key authentication."""

import os
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient


@pytest.fixture(autouse=True)
def _env():
    """Set required env vars for Settings."""
    with patch.dict(
        os.environ,
        {
            "DATABASE_URL": "postgresql://test:test@localhost:5432/test",
            "INTERNAL_API_KEY": "test-key",
        },
    ):
        yield


@pytest.fixture()
def client():
    """Create a test client with fresh app import."""
    # Force reimport so Settings picks up patched env
    import importlib
    import config as config_mod

    importlib.reload(config_mod)

    import main as main_mod

    importlib.reload(main_mod)

    return TestClient(main_mod.app, raise_server_exceptions=False)


# ── Health endpoint ──────────────────────────────────────────────────


class TestHealthEndpoint:
    def test_health_returns_200_without_api_key(self, client):
        """Health endpoint is exempt from auth."""
        resp = client.get("/health")
        assert resp.status_code == 200

    def test_health_response_shape(self, client):
        body = client.get("/health").json()
        assert "status" in body
        assert "database" in body
        assert "embedding_model" in body
        assert "version" in body

    def test_health_degraded_when_no_db(self, client):
        """Without a real DB the status should be degraded."""
        body = client.get("/health").json()
        assert body["status"] == "degraded"
        assert body["database"] is False


# ── Internal API Key Auth ────────────────────────────────────────────


class TestInternalApiKeyAuth:
    def test_protected_endpoint_rejects_missing_key(self, client):
        """Requests without X-Internal-API-Key get 401."""
        resp = client.post("/api/v1/embeddings", json={"texts": ["hello"]})
        assert resp.status_code == 401
        assert "Invalid or missing" in resp.json()["detail"]

    def test_protected_endpoint_rejects_wrong_key(self, client):
        resp = client.post(
            "/api/v1/embeddings",
            json={"texts": ["hello"]},
            headers={"X-Internal-API-Key": "wrong-key"},
        )
        assert resp.status_code == 401

    def test_protected_endpoint_accepts_valid_key(self, client):
        """With correct key the request passes auth (may fail downstream, but not 401)."""
        resp = client.post(
            "/api/v1/embeddings",
            json={"texts": ["hello"]},
            headers={"X-Internal-API-Key": "test-key"},
        )
        # Should NOT be 401 — it passed auth. Might be 500 if model not loaded, that's fine.
        assert resp.status_code != 401

    def test_vectors_endpoint_requires_key(self, client):
        resp = client.post(
            "/api/v1/vectors/search",
            json={"collection": "prompt_knowledge", "query": "test"},
        )
        assert resp.status_code == 401

    def test_vectors_endpoint_accepts_valid_key(self, client):
        resp = client.post(
            "/api/v1/vectors/search",
            json={"collection": "prompt_knowledge", "query": "test"},
            headers={"X-Internal-API-Key": "test-key"},
        )
        assert resp.status_code != 401

    def test_docs_endpoint_exempt(self, client):
        """OpenAPI docs should be accessible without auth."""
        resp = client.get("/openapi.json")
        assert resp.status_code == 200
