"""Opsevo-X Python Core — FastAPI application entry point."""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api.v1.embeddings import router as embeddings_router
from api.v1.health import router as health_router
from api.v1.vectors import router as vectors_router
from middleware.auth import InternalApiKeyMiddleware


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage application lifespan events.

    Startup: initialize database connection pool, embedding service, vector store.
    Shutdown: close database connection pool.
    """
    # --- Startup ---
    from services.embedding_service import EmbeddingService
    from services.vector_store import VectorStore

    app.state.embedding_service = EmbeddingService()

    vector_store = VectorStore()
    try:
        await vector_store.initialize()
    except Exception as exc:
        import logging

        logging.getLogger(__name__).warning(
            "VectorStore initialization failed (DB may be unavailable): %s", exc
        )
        vector_store = None
    app.state.vector_store = vector_store

    yield
    # --- Shutdown ---
    if vector_store is not None:
        await vector_store.close()


app = FastAPI(
    title="Opsevo-X Python Core",
    description="AIOps embedding and vector store service",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS — allow all origins for internal service communication
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Internal API key authentication (added after CORS so CORS headers are set first)
app.add_middleware(InternalApiKeyMiddleware)

# Register routers
app.include_router(health_router)
app.include_router(embeddings_router)
app.include_router(vectors_router)
