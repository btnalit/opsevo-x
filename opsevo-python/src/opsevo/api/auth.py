"""Auth API routes.

POST /api/auth/login
POST /api/auth/register
POST /api/auth/refresh
GET  /api/auth/me

Requirements: 3.1, 5.1, 5.2, 5.3
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status

from opsevo.api.deps import get_auth_service, get_current_user, require_role
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
from opsevo.utils.logger import get_logger

logger = get_logger(__name__)

router = APIRouter(prefix="/api/auth", tags=["auth"])

INVITATION_CODE = "OpsEvo888"


@router.post("/login")
async def login(
    body: LoginRequest,
    auth: AuthService = Depends(get_auth_service),
):
    if not body.username or not body.password:
        return ErrorResponse(error="请输入用户名和密码", code="MISSING_FIELDS").model_dump()

    try:
        user = await auth.authenticate(body.username, body.password)
    except Exception as exc:
        logger.error("login_authenticate_error", username=body.username, error=str(exc), exc_info=True)
        return ErrorResponse(error="登录服务异常，请稍后重试", code="LOGIN_ERROR").model_dump()

    if user is None:
        return ErrorResponse(error="用户名或密码错误", code="INVALID_CREDENTIALS").model_dump()

    try:
        access = auth.generate_access_token(
            str(user["id"]), user["username"], tenant_id=user.get("tenant_id"),
        )
        refresh = auth.generate_refresh_token(str(user["id"]))
    except Exception as exc:
        logger.error("login_token_generation_error", user_id=str(user["id"]), error=str(exc), exc_info=True)
        return ErrorResponse(error="登录服务异常，请稍后重试", code="LOGIN_ERROR").model_dump()

    return LoginResponse(
        data=LoginResponseData(
            token=access,
            refreshToken=refresh,
            user=UserInfo(
                id=str(user["id"]),
                username=user["username"],
                email=user.get("email") or "",
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
                email=user.get("email") or "",
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

    access = auth.generate_access_token(
        user_id, user["username"], tenant_id=user.get("tenant_id"),
    )
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
            email=user.get("email") or "",
            role=user.get("role") or "user",
            tenantId=str(user["id"]),
        ).model_dump(by_alias=True),
    ).model_dump()


# ==================== 用户管理端点 (Bug 1.1) ====================

def _strip_password(user: dict) -> dict:
    """从用户字典中移除 password_hash。"""
    return {k: v for k, v in user.items() if k != "password_hash"}


@router.get("/users")
async def list_users(
    limit: int = Query(100, le=1000, ge=1),
    offset: int = Query(0, ge=0),
    include_inactive: bool = Query(False),
    auth: AuthService = Depends(get_auth_service),
    user: dict = Depends(require_role("admin")),
):
    rows = await auth.list_users(limit=limit, offset=offset, include_inactive=include_inactive)
    return {"success": True, "data": [_strip_password(r) for r in rows]}


@router.post("/users", status_code=201)
async def create_user_admin(
    request: Request,
    auth: AuthService = Depends(get_auth_service),
    user: dict = Depends(require_role("admin")),
):
    body = await request.json()
    username = body.get("username", "")
    email = body.get("email", "")
    password = body.get("password", "")
    if not username or not email or not password:
        raise HTTPException(400, "username, email, password are required")
    try:
        new_user = await auth.create_user(username, email, password)
    except Exception:
        raise HTTPException(400, "Username or email already exists")
    return {"success": True, "data": _strip_password(new_user)}


@router.put("/users/{user_id}")
async def update_user(
    user_id: str,
    request: Request,
    auth: AuthService = Depends(get_auth_service),
    user: dict = Depends(require_role("admin")),
):
    body = await request.json()
    # 防止最后一个管理员被降级
    new_role = body.get("role")
    if new_role and new_role != "admin":
        target = await auth.get_user_by_id(user_id)
        if target and target.get("role") == "admin":
            count = await auth.count_active_admins(exclude_user_id=user_id)
            if count == 0:
                raise HTTPException(400, "Cannot demote the last admin")
    try:
        updated = await auth.update_user(user_id, body)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    if not updated:
        raise HTTPException(404, "User not found")
    return {"success": True, "data": _strip_password(updated)}


@router.post("/users/{user_id}/reset-password")
async def reset_password(
    user_id: str,
    request: Request,
    auth: AuthService = Depends(get_auth_service),
    user: dict = Depends(require_role("admin")),
):
    body = await request.json()
    new_password = body.get("password", "")
    if not new_password:
        raise HTTPException(400, "password is required")
    target = await auth.get_user_by_id(user_id)
    if not target:
        raise HTTPException(404, "User not found")
    await auth.reset_password(user_id, new_password)
    return {"success": True, "message": "Password reset"}


@router.delete("/users/{user_id}")
async def delete_user(
    user_id: str,
    auth: AuthService = Depends(get_auth_service),
    user: dict = Depends(require_role("admin")),
):
    # 禁止删除自己
    if str(user["id"]) == user_id:
        raise HTTPException(400, "Cannot delete yourself")
    target = await auth.get_user_by_id(user_id)
    if not target:
        raise HTTPException(404, "User not found")
    # 禁止删除最后一个管理员
    if target.get("role") == "admin":
        count = await auth.count_active_admins(exclude_user_id=user_id)
        if count == 0:
            raise HTTPException(400, "Cannot delete the last admin")
    try:
        await auth.delete_user(user_id)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    return {"success": True, "message": "User deactivated"}


@router.post("/users/{user_id}/restore")
async def restore_user(
    user_id: str,
    auth: AuthService = Depends(get_auth_service),
    user: dict = Depends(require_role("admin")),
):
    try:
        restored = await auth.restore_user(user_id)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    if not restored:
        raise HTTPException(404, "User not found")
    return {"success": True, "data": _strip_password(restored)}
