"""Tests for the Embedding Service and POST /api/v1/embeddings endpoint."""

import unittest
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import numpy as np
import pytest
from fastapi.testclient import TestClient


# ---------------------------------------------------------------------------
# Helpers — patch settings before importing app modules
# ---------------------------------------------------------------------------

def _make_app():
    """Create a fresh FastAPI app with EmbeddingService on app.state."""
    # Import inside function so patches take effect
    from main import app
    return app


# Auth header for internal API key (matches conftest.py default)
_AUTH = {"X-Internal-API-Key": "test-key"}


# ---------------------------------------------------------------------------
# EmbeddingService unit tests
# ---------------------------------------------------------------------------


class TestEmbeddingServiceLocal:
    """Tests for local (sentence-transformers) mode."""

    @patch("services.embedding_service.settings")
    def test_is_remote_false_when_no_url(self, mock_settings):
        mock_settings.EMBEDDING_MODEL = "all-MiniLM-L6-v2"
        mock_settings.EMBEDDING_REMOTE_URL = None
        mock_settings.EMBEDDING_REMOTE_API_KEY = None

        from services.embedding_service import EmbeddingService
        svc = EmbeddingService()
        assert svc.is_remote is False

    @patch("services.embedding_service.settings")
    def test_is_remote_true_when_url_set(self, mock_settings):
        mock_settings.EMBEDDING_MODEL = "text-embedding-ada-002"
        mock_settings.EMBEDDING_REMOTE_URL = "https://api.openai.com/v1/embeddings"
        mock_settings.EMBEDDING_REMOTE_API_KEY = "sk-test"

        from services.embedding_service import EmbeddingService
        svc = EmbeddingService()
        assert svc.is_remote is True

    @patch("services.embedding_service.settings")
    def test_model_name_property(self, mock_settings):
        mock_settings.EMBEDDING_MODEL = "my-model"
        mock_settings.EMBEDDING_REMOTE_URL = None
        mock_settings.EMBEDDING_REMOTE_API_KEY = None

        from services.embedding_service import EmbeddingService
        svc = EmbeddingService()
        assert svc.model_name == "my-model"

    @patch("services.embedding_service.settings")
    def test_get_dimensions_default_minilm(self, mock_settings):
        mock_settings.EMBEDDING_MODEL = "all-MiniLM-L6-v2"
        mock_settings.EMBEDDING_REMOTE_URL = None
        mock_settings.EMBEDDING_REMOTE_API_KEY = None

        from services.embedding_service import EmbeddingService
        svc = EmbeddingService()
        assert svc.get_dimensions() == 384

    @patch("services.embedding_service.settings")
    def test_get_dimensions_unknown_model(self, mock_settings):
        mock_settings.EMBEDDING_MODEL = "unknown-model"
        mock_settings.EMBEDDING_REMOTE_URL = None
        mock_settings.EMBEDDING_REMOTE_API_KEY = None

        from services.embedding_service import EmbeddingService
        svc = EmbeddingService()
        assert svc.get_dimensions() == 0

    @patch("services.embedding_service.settings")
    @pytest.mark.asyncio
    async def test_embed_local_calls_model_encode(self, mock_settings):
        mock_settings.EMBEDDING_MODEL = "all-MiniLM-L6-v2"
        mock_settings.EMBEDDING_REMOTE_URL = None
        mock_settings.EMBEDDING_REMOTE_API_KEY = None

        from services.embedding_service import EmbeddingService
        svc = EmbeddingService()

        fake_embeddings = np.array([[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]])
        mock_model = MagicMock()
        mock_model.encode.return_value = fake_embeddings
        svc._local_model = mock_model

        result = await svc.embed(["hello", "world"])

        mock_model.encode.assert_called_once_with(["hello", "world"], convert_to_numpy=True)
        assert len(result) == 2
        assert result[0] == pytest.approx([0.1, 0.2, 0.3])

    @patch("services.embedding_service.settings")
    @pytest.mark.asyncio
    async def test_embed_local_model_load_failure(self, mock_settings):
        mock_settings.EMBEDDING_MODEL = "nonexistent-model"
        mock_settings.EMBEDDING_REMOTE_URL = None
        mock_settings.EMBEDDING_REMOTE_API_KEY = None

        from services.embedding_service import EmbeddingService
        svc = EmbeddingService()

        with patch(
            "services.embedding_service.EmbeddingService._load_local_model",
            side_effect=RuntimeError("Failed to load"),
        ):
            with pytest.raises(RuntimeError, match="Failed to load"):
                await svc.embed(["test"])


class TestEmbeddingServiceRemote:
    """Tests for remote (OpenAI-compatible) mode."""

    @patch("services.embedding_service.settings")
    @pytest.mark.asyncio
    async def test_embed_remote_success(self, mock_settings):
        mock_settings.EMBEDDING_MODEL = "text-embedding-ada-002"
        mock_settings.EMBEDDING_REMOTE_URL = "https://api.example.com/v1/embeddings"
        mock_settings.EMBEDDING_REMOTE_API_KEY = "sk-test"

        from services.embedding_service import EmbeddingService
        svc = EmbeddingService()

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "data": [
                {"embedding": [0.1, 0.2, 0.3]},
                {"embedding": [0.4, 0.5, 0.6]},
            ]
        }
        mock_response.raise_for_status = MagicMock()

        with patch("httpx.AsyncClient") as MockClient:
            mock_client_instance = AsyncMock()
            mock_client_instance.post.return_value = mock_response
            mock_client_instance.__aenter__ = AsyncMock(return_value=mock_client_instance)
            mock_client_instance.__aexit__ = AsyncMock(return_value=False)
            MockClient.return_value = mock_client_instance

            result = await svc.embed(["hello", "world"])

        assert len(result) == 2
        assert result[0] == [0.1, 0.2, 0.3]

    @patch("services.embedding_service.settings")
    @pytest.mark.asyncio
    async def test_embed_remote_timeout(self, mock_settings):
        mock_settings.EMBEDDING_MODEL = "text-embedding-ada-002"
        mock_settings.EMBEDDING_REMOTE_URL = "https://api.example.com/v1/embeddings"
        mock_settings.EMBEDDING_REMOTE_API_KEY = "sk-test"

        from services.embedding_service import EmbeddingService
        svc = EmbeddingService()

        with patch("httpx.AsyncClient") as MockClient:
            mock_client_instance = AsyncMock()
            mock_client_instance.post.side_effect = httpx.TimeoutException("timeout")
            mock_client_instance.__aenter__ = AsyncMock(return_value=mock_client_instance)
            mock_client_instance.__aexit__ = AsyncMock(return_value=False)
            MockClient.return_value = mock_client_instance

            with pytest.raises(RuntimeError, match="timed out"):
                await svc.embed(["test"])

    @patch("services.embedding_service.settings")
    @pytest.mark.asyncio
    async def test_embed_remote_sends_auth_header(self, mock_settings):
        mock_settings.EMBEDDING_MODEL = "text-embedding-ada-002"
        mock_settings.EMBEDDING_REMOTE_URL = "https://api.example.com/v1/embeddings"
        mock_settings.EMBEDDING_REMOTE_API_KEY = "sk-mykey"

        from services.embedding_service import EmbeddingService
        svc = EmbeddingService()

        mock_response = MagicMock()
        mock_response.json.return_value = {"data": [{"embedding": [0.1]}]}
        mock_response.raise_for_status = MagicMock()

        with patch("httpx.AsyncClient") as MockClient:
            mock_client_instance = AsyncMock()
            mock_client_instance.post.return_value = mock_response
            mock_client_instance.__aenter__ = AsyncMock(return_value=mock_client_instance)
            mock_client_instance.__aexit__ = AsyncMock(return_value=False)
            MockClient.return_value = mock_client_instance

            await svc.embed(["test"])

            call_kwargs = mock_client_instance.post.call_args
            headers = call_kwargs.kwargs.get("headers", {})
            assert headers["Authorization"] == "Bearer sk-mykey"


# ---------------------------------------------------------------------------
# Endpoint integration tests (using TestClient)
# ---------------------------------------------------------------------------


class TestEmbeddingsEndpoint:
    """Tests for POST /api/v1/embeddings via FastAPI TestClient."""

    @patch("services.embedding_service.settings")
    def test_empty_texts_returns_422(self, mock_settings):
        mock_settings.EMBEDDING_MODEL = "all-MiniLM-L6-v2"
        mock_settings.EMBEDDING_REMOTE_URL = None
        mock_settings.EMBEDDING_REMOTE_API_KEY = None

        app = _make_app()
        client = TestClient(app)
        resp = client.post("/api/v1/embeddings", json={"texts": []}, headers=_AUTH)
        assert resp.status_code == 422

    @patch("services.embedding_service.settings")
    def test_successful_embedding(self, mock_settings):
        mock_settings.EMBEDDING_MODEL = "all-MiniLM-L6-v2"
        mock_settings.EMBEDDING_REMOTE_URL = None
        mock_settings.EMBEDDING_REMOTE_API_KEY = None

        app = _make_app()

        # Patch the embed method on the service instance created during lifespan
        fake_vectors = [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]]

        with TestClient(app) as client:
            # Replace embed on the live service
            svc = app.state.embedding_service
            svc.embed = AsyncMock(return_value=fake_vectors)

            resp = client.post(
                "/api/v1/embeddings",
                json={"texts": ["hello", "world"]},
                headers=_AUTH,
            )

        assert resp.status_code == 200
        data = resp.json()
        assert data["model"] == "all-MiniLM-L6-v2"
        assert data["dimensions"] == 3
        assert len(data["embeddings"]) == 2

    @patch("services.embedding_service.settings")
    def test_custom_model_in_response(self, mock_settings):
        mock_settings.EMBEDDING_MODEL = "all-MiniLM-L6-v2"
        mock_settings.EMBEDDING_REMOTE_URL = None
        mock_settings.EMBEDDING_REMOTE_API_KEY = None

        app = _make_app()
        fake_vectors = [[0.1, 0.2]]

        with TestClient(app) as client:
            svc = app.state.embedding_service
            svc.embed = AsyncMock(return_value=fake_vectors)

            resp = client.post(
                "/api/v1/embeddings",
                json={"texts": ["hello"], "model": "custom-model"},
                headers=_AUTH,
            )

        assert resp.status_code == 200
        assert resp.json()["model"] == "custom-model"

    @patch("services.embedding_service.settings")
    def test_service_error_returns_503(self, mock_settings):
        mock_settings.EMBEDDING_MODEL = "all-MiniLM-L6-v2"
        mock_settings.EMBEDDING_REMOTE_URL = None
        mock_settings.EMBEDDING_REMOTE_API_KEY = None

        app = _make_app()

        with TestClient(app) as client:
            svc = app.state.embedding_service
            svc.embed = AsyncMock(side_effect=RuntimeError("Model crashed"))

            resp = client.post(
                "/api/v1/embeddings",
                json={"texts": ["hello"]},
                headers=_AUTH,
            )

        assert resp.status_code == 503
        assert "Model crashed" in resp.json()["detail"]

    @patch("services.embedding_service.settings")
    def test_missing_texts_field_returns_422(self, mock_settings):
        mock_settings.EMBEDDING_MODEL = "all-MiniLM-L6-v2"
        mock_settings.EMBEDDING_REMOTE_URL = None
        mock_settings.EMBEDDING_REMOTE_API_KEY = None

        app = _make_app()
        client = TestClient(app)
        resp = client.post("/api/v1/embeddings", json={}, headers=_AUTH)
        assert resp.status_code == 422
