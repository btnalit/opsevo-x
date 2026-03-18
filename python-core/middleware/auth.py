"""Internal API key authentication middleware.

Validates the X-Internal-API-Key header on all requests except
health check endpoints, which are exempt to allow Docker health probes.
"""

import logging

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.responses import JSONResponse

from config import settings

logger = logging.getLogger(__name__)

# Paths exempt from API key authentication
EXEMPT_PATHS = frozenset({"/health", "/docs", "/openapi.json", "/redoc"})


class InternalApiKeyMiddleware(BaseHTTPMiddleware):
    """Reject requests missing a valid X-Internal-API-Key header."""

    async def dispatch(
        self, request: Request, call_next: RequestResponseEndpoint
    ) -> Response:
        if request.url.path in EXEMPT_PATHS:
            return await call_next(request)

        api_key = request.headers.get("X-Internal-API-Key")
        if not api_key or api_key != settings.INTERNAL_API_KEY:
            logger.warning(
                "Unauthorized request to %s from %s",
                request.url.path,
                request.client.host if request.client else "unknown",
            )
            return JSONResponse(
                status_code=401,
                content={"detail": "Invalid or missing internal API key"},
            )

        return await call_next(request)
