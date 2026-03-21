"""FastAPI shared dependencies.

Provides reusable Depends() callables for auth, datastore, device context, etc.
These are wired up in container.py / main.py lifespan.
"""

from __future__ import annotations

from typing import Any

from fastapi import Depends, HTTPException, Query, Request, status
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


def get_feature_flag_manager(request: Request):
    return _get_container(request).feature_flag_manager()


def get_tracing_service(request: Request):
    return _get_container(request).tracing_service()


async def get_current_user(
    request: Request,
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> dict[str, Any]:
    """Decode JWT and return user dict. Raises 401 on failure.

    Supports two token sources:
    1. Authorization: Bearer <token> header (standard REST calls)
    2. ?token=<token> query param (EventSource/SSE, which cannot set headers)
    """
    token: str | None = creds.credentials if creds else None
    # Fallback: SSE EventSource passes token as query param
    if token is None:
        token = request.query_params.get("token")
    if token is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing token")
    auth_svc: AuthService = get_auth_service(request)
    try:
        payload = auth_svc.verify_token(token)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc))
    user = await auth_svc.get_user_by_id(payload["sub"])
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    # 软删除用户 JWT 失效
    if not user.get("is_active", True):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User deactivated")
    return user


def require_role(role: str):
    """返回一个依赖函数，检查当前用户是否具有指定角色。"""
    async def _check(user: dict = Depends(get_current_user)):
        if user.get("role") != role:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Requires '{role}' role",
            )
        return user
    return _check


def get_device_id(
    deviceId: str | None = Query(None, alias="deviceId"),
) -> str | None:
    """Normalize device_id query param: empty string → None.

    The frontend sends '' when "全部设备" (all devices) is selected.
    PostgreSQL cannot cast '' to UUID, so we convert it to None here.
    All ai-ops endpoints should use ``Depends(get_device_id)`` instead of
    reading the query param directly.
    """
    return deviceId.strip() if deviceId and deviceId.strip() else None


def get_rag_engine(request: Request):
    return _get_container(request).rag_engine()
