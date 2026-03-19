"""Request timeout middleware.

Requirements: 3.3
"""

from __future__ import annotations

import asyncio
from typing import Callable

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware

# Paths that get extended timeout (120s)
_LONG_TIMEOUT_PREFIXES = ("/api/devices/", "/api/ai/")
_LONG_TIMEOUT_SUFFIXES = ("/stream", "/execute", "/script")

# SSE endpoints — no timeout
_SSE_SUFFIXES = ("/chat/stream", "/events/stream")

DEFAULT_TIMEOUT = 25.0
LONG_TIMEOUT = 120.0


class TimeoutMiddleware(BaseHTTPMiddleware):
    """Apply per-request timeouts based on endpoint path."""

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        path = request.url.path

        # SSE endpoints: no timeout
        if any(path.endswith(s) for s in _SSE_SUFFIXES):
            return await call_next(request)

        # Long-running endpoints
        if any(path.startswith(p) for p in _LONG_TIMEOUT_PREFIXES) and any(
            path.endswith(s) for s in _LONG_TIMEOUT_SUFFIXES
        ):
            timeout = LONG_TIMEOUT
        else:
            timeout = DEFAULT_TIMEOUT

        try:
            return await asyncio.wait_for(call_next(request), timeout=timeout)
        except asyncio.TimeoutError:
            return Response(
                content='{"detail":"Request timeout"}',
                status_code=504,
                media_type="application/json",
            )
