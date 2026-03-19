"""FastAPI shared dependencies.

Provides reusable Depends() callables for auth, datastore, device context, etc.
These are wired up in container.py / main.py lifespan.
"""

from __future__ import annotations

from typing import Any

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from opsevo.data.datastore import DataStore
from opsevo.services.auth_service import AuthService

_bearer = HTTPBearer(auto_error=False)


def _get_container(request: Request):
    return request.app.state.container


def get_datastore(request: Request) -> DataStore:
    return _get_container(request).datastore()


def get_auth_service(request: Request) -> AuthService:
    return _get_container(request).auth_service()


async def get_current_user(
    request: Request,
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> dict[str, Any]:
    """Decode JWT and return user dict. Raises 401 on failure."""
    if creds is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing token")
    auth_svc: AuthService = get_auth_service(request)
    try:
        payload = auth_svc.verify_token(creds.credentials)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc))
    user = await auth_svc.get_user_by_id(payload["sub"])
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    return user
