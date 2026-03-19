"""Auth API routes.

POST /api/auth/login
POST /api/auth/register
POST /api/auth/refresh
GET  /api/auth/me

Requirements: 3.1, 5.1, 5.2, 5.3
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from opsevo.api.deps import get_auth_service, get_current_user
from opsevo.models.auth import (
    LoginRequest,
    LoginResponse,
    LoginResponseData,
    RefreshResponse,
    RefreshResponseData,
    RefreshTokenRequest,
    RegisterRequest,
    RegisterResponse,
    RegisterResponseData,
    UserInfo,
)
from opsevo.models.common import ErrorResponse, SuccessResponse
from opsevo.services.auth_service import AuthService

router = APIRouter(prefix="/api/auth", tags=["auth"])

INVITATION_CODE = "OpsEvo888"


@router.post("/login")
async def login(
    body: LoginRequest,
    auth: AuthService = Depends(get_auth_service),
):
    if not body.username or not body.password:
        return ErrorResponse(error="请输入用户名和密码", code="MISSING_FIELDS").model_dump()

    user = await auth.authenticate(body.username, body.password)
    if user is None:
        return ErrorResponse(error="用户名或密码错误", code="INVALID_CREDENTIALS").model_dump()

    access = auth.generate_access_token(str(user["id"]), user["username"])
    refresh = auth.generate_refresh_token(str(user["id"]))

    return LoginResponse(
        data=LoginResponseData(
            token=access,
            refreshToken=refresh,
            user=UserInfo(
                id=str(user["id"]),
                username=user["username"],
                email=user.get("email", ""),
                tenantId=str(user["id"]),
            ),
        ),
    ).model_dump(by_alias=True)


@router.post("/register", status_code=201)
async def register(
    body: RegisterRequest,
    auth: AuthService = Depends(get_auth_service),
):
    if not body.username or not body.email or not body.password:
        return ErrorResponse(error="请填写所有必填字段", code="MISSING_FIELDS").model_dump()

    if body.invitation_code != INVITATION_CODE:
        return ErrorResponse(error="邀请码无效", code="INVALID_INVITATION_CODE").model_dump()

    try:
        user = await auth.create_user(body.username, body.email, body.password)
    except Exception:
        return ErrorResponse(error="用户名或邮箱已存在", code="USERNAME_OR_EMAIL_EXISTS").model_dump()
    return RegisterResponse(
        data=RegisterResponseData(
            user=UserInfo(
                id=str(user["id"]),
                username=user["username"],
                email=user.get("email", ""),
            ),
        ),
    ).model_dump(by_alias=True)


@router.post("/refresh")
async def refresh(
    body: RefreshTokenRequest,
    auth: AuthService = Depends(get_auth_service),
):
    try:
        payload = auth.verify_token(body.refresh_token)
    except ValueError as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail=str(exc))

    if payload.get("type") != "refresh":
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="Invalid token type")

    user_id = payload["sub"]
    user = await auth.get_user_by_id(user_id)
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="User not found")

    access = auth.generate_access_token(user_id, user["username"])
    new_refresh = auth.generate_refresh_token(user_id)

    return RefreshResponse(
        data=RefreshResponseData(token=access, refreshToken=new_refresh),
    ).model_dump(by_alias=True)


@router.get("/me")
async def me(user: dict = Depends(get_current_user)):
    return SuccessResponse(
        data=UserInfo(
            id=str(user["id"]),
            username=user["username"],
            email=user.get("email", ""),
            role=user.get("role", "user"),
            tenantId=str(user["id"]),
        ).model_dump(by_alias=True),
    ).model_dump()
