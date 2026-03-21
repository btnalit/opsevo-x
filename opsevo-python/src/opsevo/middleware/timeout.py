"""Request timeout middleware (pure ASGI implementation).

Requirements: 3.3

Uses a raw ASGI middleware instead of ``BaseHTTPMiddleware`` to avoid the
well-known Starlette issue where ``BaseHTTPMiddleware`` + ``StreamingResponse``
can deadlock the server when combined with ``asyncio.wait_for``.

See: https://github.com/encode/starlette/issues/1012
"""

from __future__ import annotations

import asyncio
from typing import Any, Callable

from starlette.requests import Request
from starlette.responses import Response
from starlette.types import ASGIApp, Receive, Scope, Send

# Paths that get extended timeout (120s) — must also match a suffix
_LONG_TIMEOUT_PREFIXES = ("/api/devices/", "/api/ai/")
_LONG_TIMEOUT_SUFFIXES = ("/stream", "/execute", "/script")

# SSE / streaming endpoints — bypass timeout entirely
_NO_TIMEOUT_PATTERNS = (
    "/stream",       # catches all SSE streams
    "/execute/stream",
)

DEFAULT_TIMEOUT = 30.0
LONG_TIMEOUT = 120.0


class TimeoutMiddleware:
    """Pure ASGI timeout middleware.

    For SSE / streaming endpoints the request is passed through without any
    timeout wrapper.  For normal endpoints an ``asyncio.wait_for`` guard is
    applied so that slow handlers return 504 instead of hanging forever.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path: str = scope.get("path", "")

        # SSE / streaming endpoints: no timeout at all
        if any(path.endswith(p) for p in _NO_TIMEOUT_PATTERNS):
            await self.app(scope, receive, send)
            return

        # Determine timeout
        if (
            any(path.startswith(p) for p in _LONG_TIMEOUT_PREFIXES)
            and any(path.endswith(s) for s in _LONG_TIMEOUT_SUFFIXES)
        ):
            timeout = LONG_TIMEOUT
        else:
            timeout = DEFAULT_TIMEOUT

        try:
            await asyncio.wait_for(
                self.app(scope, receive, send),
                timeout=timeout,
            )
        except asyncio.TimeoutError:
            # Send a 504 response manually via ASGI
            response = Response(
                content='{"detail":"Request timeout"}',
                status_code=504,
                media_type="application/json",
            )
            await response(scope, receive, send)
