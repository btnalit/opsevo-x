"""Tests for the Vector Store service and API endpoints."""

import uuid
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_test_app():
    """Create a FastAPI app with mocked VectorStore (no real DB connection)."""
    from api.v1.embeddings import router as embeddings_router
    from api.v1.health import router as health_router
    from api.v1.vectors import router as vectors_router
    from services.embedding_service import EmbeddingService

    @asynccontextmanager
    async def test_lifespan(app: FastAPI):
        app.state.embedding_service = EmbeddingService()
        app.state.vector_store = AsyncMock()
        yield

    app = FastAPI(lifespan=test_lifespan)
    app.include_router(health_router)
    app.include_router(embeddings_router)
    app.include_router(vectors_router)
    return app


# ---------------------------------------------------------------------------
# VectorStore unit tests
# ---------------------------------------------------------------------------


class TestVectorStoreHelpers:
    """Tests for module-level helper functions."""

    def test_format_vector(self):
        from services.vector_store import _format_vector
        assert _format_vector([0.1, 0.2, 0.3]) == "[0.1,0.2,0.3]"

    def test_format_vector_empty(self):
        from services.vector_store import _format_vector
        assert _format_vector([]) == "[]"

    def test_json_dumps(self):
        from services.vector_store import _json_dumps
        result = _json_dumps({"key": "value"})
        assert '"key"' in result and '"value"' in result

    def test_parse_metadata_dict(self):
        from services.vector_store import _parse_metadata
        assert _parse_metadata({"a": 1}) == {"a": 1}

    def test_parse_metadata_string(self):
        from services.vector_store import _parse_metadata
        assert _parse_metadata('{"a": 1}') == {"a": 1}

    def test_parse_metadata_none(self):
        from services.vector_store import _parse_metadata
        assert _parse_metadata(None) == {}

    def test_parse_metadata_invalid_string(self):
        from services.vector_store import _parse_metadata
        assert _parse_metadata("not json") == {}


class TestVectorStoreCollections:
    """Tests for collection config resolution."""

    def test_valid_collections(self):
        from services.vector_store import VectorStore
        store = VectorStore()
        for name in ["prompt_knowledge", "tool_vectors", "vector_documents"]:
            cfg = store._get_collection(name)
            assert cfg.table == name

    def test_invalid_collection_raises(self):
        from services.vector_store import VectorStore
        store = VectorStore()
        with pytest.raises(ValueError, match="Unknown collection"):
            store._get_collection("nonexistent")

    def test_prompt_knowledge_content_column(self):
        from services.vector_store import VectorStore
        store = VectorStore()
        cfg = store._get_collection("prompt_knowledge")
        assert cfg.content_column == "text"
        assert cfg.has_embedding is True

    def test_tool_vectors_content_column(self):
        from services.vector_store import VectorStore
        store = VectorStore()
        cfg = store._get_collection("tool_vectors")
        assert cfg.content_column == "description"
        assert cfg.has_embedding is True

    def test_vector_documents_content_column(self):
        from services.vector_store import VectorStore
        store = VectorStore()
        cfg = store._get_collection("vector_documents")
        assert cfg.content_column == "content"


class TestSearchResult:
    def test_search_result_creation(self):
        from services.vector_store import SearchResult
        r = SearchResult(id="abc", content="hello", score=0.95, metadata={"k": "v"})
        assert r.id == "abc"
        assert r.content == "hello"
        assert r.score == 0.95
        assert r.metadata == {"k": "v"}


# ---------------------------------------------------------------------------
# API endpoint tests (mocked VectorStore, no DB)
# ---------------------------------------------------------------------------


class TestUpsertEndpoint:
    @patch("services.embedding_service.settings")
    def test_upsert_with_embedding(self, mock_settings):
        mock_settings.EMBEDDING_MODEL = "all-MiniLM-L6-v2"
        mock_settings.EMBEDDING_REMOTE_URL = None
        mock_settings.EMBEDDING_REMOTE_API_KEY = None
        app = _make_test_app()
        with TestClient(app) as client:
            app.state.vector_store.upsert.return_value = "test-id-123"
            resp = client.post("/api/v1/vectors/upsert", json={
                "collection": "prompt_knowledge",
                "id": "test-id-123",
                "content": "test content",
                "embedding": [0.1, 0.2, 0.3],
                "metadata": {"category": "test"},
            })
        assert resp.status_code == 200
        data = resp.json()
        assert data["id"] == "test-id-123"
        assert data["collection"] == "prompt_knowledge"

    @patch("services.embedding_service.settings")
    def test_upsert_auto_embed(self, mock_settings):
        mock_settings.EMBEDDING_MODEL = "all-MiniLM-L6-v2"
        mock_settings.EMBEDDING_REMOTE_URL = None
        mock_settings.EMBEDDING_REMOTE_API_KEY = None
        app = _make_test_app()
        with TestClient(app) as client:
            app.state.vector_store.upsert.return_value = "auto-id"
            svc = app.state.embedding_service
            svc.embed = AsyncMock(return_value=[[0.1, 0.2, 0.3]])
            resp = client.post("/api/v1/vectors/upsert", json={
                "collection": "vector_documents",
                "content": "auto embed me",
                "metadata": {},
            })
        assert resp.status_code == 200
        svc.embed.assert_called_once_with(["auto embed me"])

    @patch("services.embedding_service.settings")
    def test_upsert_invalid_collection(self, mock_settings):
        mock_settings.EMBEDDING_MODEL = "all-MiniLM-L6-v2"
        mock_settings.EMBEDDING_REMOTE_URL = None
        mock_settings.EMBEDDING_REMOTE_API_KEY = None
        app = _make_test_app()
        with TestClient(app) as client:
            resp = client.post("/api/v1/vectors/upsert", json={
                "collection": "invalid_collection",
                "content": "test",
                "embedding": [0.1],
            })
        assert resp.status_code == 422

    @patch("services.embedding_service.settings")
    def test_upsert_empty_content(self, mock_settings):
        mock_settings.EMBEDDING_MODEL = "all-MiniLM-L6-v2"
        mock_settings.EMBEDDING_REMOTE_URL = None
        mock_settings.EMBEDDING_REMOTE_API_KEY = None
        app = _make_test_app()
        with TestClient(app) as client:
            resp = client.post("/api/v1/vectors/upsert", json={
                "collection": "prompt_knowledge",
                "content": "   ",
                "embedding": [0.1],
            })
        assert resp.status_code == 422

    @patch("services.embedding_service.settings")
    def test_upsert_embedding_service_failure(self, mock_settings):
        mock_settings.EMBEDDING_MODEL = "all-MiniLM-L6-v2"
        mock_settings.EMBEDDING_REMOTE_URL = None
        mock_settings.EMBEDDING_REMOTE_API_KEY = None
        app = _make_test_app()
        with TestClient(app) as client:
            svc = app.state.embedding_service
            svc.embed = AsyncMock(side_effect=RuntimeError("Model down"))
            resp = client.post("/api/v1/vectors/upsert", json={
                "collection": "vector_documents",
                "content": "test",
            })
        assert resp.status_code == 503
        assert "Embedding service unavailable" in resp.json()["detail"]

    @patch("services.embedding_service.settings")
    def test_upsert_vector_store_error(self, mock_settings):
        mock_settings.EMBEDDING_MODEL = "all-MiniLM-L6-v2"
        mock_settings.EMBEDDING_REMOTE_URL = None
        mock_settings.EMBEDDING_REMOTE_API_KEY = None
        app = _make_test_app()
        with TestClient(app) as client:
            app.state.vector_store.upsert.side_effect = Exception("DB error")
            resp = client.post("/api/v1/vectors/upsert", json={
                "collection": "prompt_knowledge",
                "content": "test",
                "embedding": [0.1],
                "metadata": {"category": "test"},
            })
        assert resp.status_code == 500
        assert "Vector store error" in resp.json()["detail"]


class TestSearchEndpoint:
    @patch("services.embedding_service.settings")
    def test_search_with_embedding(self, mock_settings):
        mock_settings.EMBEDDING_MODEL = "all-MiniLM-L6-v2"
        mock_settings.EMBEDDING_REMOTE_URL = None
        mock_settings.EMBEDDING_REMOTE_API_KEY = None
        app = _make_test_app()
        with TestClient(app) as client:
            from services.vector_store import SearchResult
            app.state.vector_store.search.return_value = [
                SearchResult(id="r1", content="result 1", score=0.95, metadata={"k": "v"}),
                SearchResult(id="r2", content="result 2", score=0.80, metadata={}),
            ]
            resp = client.post("/api/v1/vectors/search", json={
                "collection": "prompt_knowledge",
                "query_embedding": [0.1, 0.2, 0.3],
                "top_k": 2,
            })
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["results"]) == 2
        assert data["results"][0]["id"] == "r1"
        assert data["results"][0]["score"] == 0.95

    @patch("services.embedding_service.settings")
    def test_search_with_text_query(self, mock_settings):
        mock_settings.EMBEDDING_MODEL = "all-MiniLM-L6-v2"
        mock_settings.EMBEDDING_REMOTE_URL = None
        mock_settings.EMBEDDING_REMOTE_API_KEY = None
        app = _make_test_app()
        with TestClient(app) as client:
            from services.vector_store import SearchResult
            app.state.vector_store.search.return_value = [
                SearchResult(id="r1", content="found", score=0.9, metadata={}),
            ]
            svc = app.state.embedding_service
            svc.embed = AsyncMock(return_value=[[0.1, 0.2, 0.3]])
            resp = client.post("/api/v1/vectors/search", json={
                "collection": "tool_vectors",
                "query": "find network tools",
                "top_k": 3,
            })
        assert resp.status_code == 200
        svc.embed.assert_called_once_with(["find network tools"])
        assert len(resp.json()["results"]) == 1

    @patch("services.embedding_service.settings")
    def test_search_no_query_returns_400(self, mock_settings):
        mock_settings.EMBEDDING_MODEL = "all-MiniLM-L6-v2"
        mock_settings.EMBEDDING_REMOTE_URL = None
        mock_settings.EMBEDDING_REMOTE_API_KEY = None
        app = _make_test_app()
        with TestClient(app) as client:
            resp = client.post("/api/v1/vectors/search", json={
                "collection": "prompt_knowledge",
            })
        assert resp.status_code == 400
        assert "query" in resp.json()["detail"].lower()

    @patch("services.embedding_service.settings")
    def test_search_invalid_collection(self, mock_settings):
        mock_settings.EMBEDDING_MODEL = "all-MiniLM-L6-v2"
        mock_settings.EMBEDDING_REMOTE_URL = None
        mock_settings.EMBEDDING_REMOTE_API_KEY = None
        app = _make_test_app()
        with TestClient(app) as client:
            resp = client.post("/api/v1/vectors/search", json={
                "collection": "bad_collection",
                "query_embedding": [0.1],
            })
        assert resp.status_code == 422

    @patch("services.embedding_service.settings")
    def test_search_with_filter(self, mock_settings):
        mock_settings.EMBEDDING_MODEL = "all-MiniLM-L6-v2"
        mock_settings.EMBEDDING_REMOTE_URL = None
        mock_settings.EMBEDDING_REMOTE_API_KEY = None
        app = _make_test_app()
        with TestClient(app) as client:
            app.state.vector_store.search.return_value = []
            resp = client.post("/api/v1/vectors/search", json={
                "collection": "prompt_knowledge",
                "query_embedding": [0.1, 0.2],
                "filter": {"category": "network"},
            })
        assert resp.status_code == 200
        call_kwargs = app.state.vector_store.search.call_args.kwargs
        assert call_kwargs["filter"] == {"category": "network"}


class TestDeleteEndpoint:
    @patch("services.embedding_service.settings")
    def test_delete_success(self, mock_settings):
        mock_settings.EMBEDDING_MODEL = "all-MiniLM-L6-v2"
        mock_settings.EMBEDDING_REMOTE_URL = None
        mock_settings.EMBEDDING_REMOTE_API_KEY = None
        app = _make_test_app()
        with TestClient(app) as client:
            app.state.vector_store.delete.return_value = True
            resp = client.delete("/api/v1/vectors/prompt_knowledge/test-id")
        assert resp.status_code == 204

    @patch("services.embedding_service.settings")
    def test_delete_not_found(self, mock_settings):
        mock_settings.EMBEDDING_MODEL = "all-MiniLM-L6-v2"
        mock_settings.EMBEDDING_REMOTE_URL = None
        mock_settings.EMBEDDING_REMOTE_API_KEY = None
        app = _make_test_app()
        with TestClient(app) as client:
            app.state.vector_store.delete.return_value = False
            resp = client.delete("/api/v1/vectors/prompt_knowledge/nonexistent")
        assert resp.status_code == 404

    @patch("services.embedding_service.settings")
    def test_delete_invalid_collection(self, mock_settings):
        mock_settings.EMBEDDING_MODEL = "all-MiniLM-L6-v2"
        mock_settings.EMBEDDING_REMOTE_URL = None
        mock_settings.EMBEDDING_REMOTE_API_KEY = None
        app = _make_test_app()
        with TestClient(app) as client:
            resp = client.delete("/api/v1/vectors/bad_collection/test-id")
        assert resp.status_code == 400
