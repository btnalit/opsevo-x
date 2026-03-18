"""Health check endpoint.

Exempt from internal API key authentication to allow Docker health checks.
Returns database connection status, embedding model info, and version.
"""

import logging

from fastapi import APIRouter, Request

from config import settings

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("/health")
async def health_check(request: Request):
    """Return service health status."""
    db_ok = False
    vector_store = getattr(request.app.state, "vector_store", None)

    if vector_store is not None and vector_store._pool is not None:
        try:
            async with vector_store._pool.connection() as conn:
                await conn.execute("SELECT 1")
            db_ok = True
        except Exception as exc:
            logger.warning("Health check DB probe failed: %s", exc)

    status = "healthy" if db_ok else "degraded"

    return {
        "status": status,
        "database": db_ok,
        "embedding_model": settings.EMBEDDING_MODEL,
        "version": settings.APP_VERSION,
    }
