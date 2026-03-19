"""Authentication Pydantic models.

Field names and types match the TS backend JSON responses exactly.
Requirements: 2.3, 3.2, 5.1
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


# ── Requests ──────────────────────────────────────────────────────────────

class LoginRequest(BaseModel):
    username: str
    password: str


class RegisterRequest(BaseModel):
    username: str
    email: str
    password: str
    invitation_code: str = Field(alias="invitationCode", default="")


class RefreshTokenRequest(BaseModel):
    refresh_token: str = Field(alias="refreshToken")


# ── Responses ─────────────────────────────────────────────────────────────

class UserInfo(BaseModel):
    id: str
    username: str
    email: str = ""
    role: str = "user"
    tenant_id: str = Field(default="", alias="tenantId")
    created_at: datetime | None = Field(default=None, alias="created_at")
    updated_at: datetime | None = Field(default=None, alias="updated_at")

    model_config = {"populate_by_name": True}


class LoginResponseData(BaseModel):
    token: str
    refresh_token: str = Field(alias="refreshToken", default="")
    user: UserInfo

    model_config = {"populate_by_name": True}


class LoginResponse(BaseModel):
    success: bool = True
    data: LoginResponseData


class RegisterResponseData(BaseModel):
    user: UserInfo


class RegisterResponse(BaseModel):
    success: bool = True
    data: RegisterResponseData


class RefreshResponseData(BaseModel):
    token: str
    refresh_token: str = Field(alias="refreshToken", default="")

    model_config = {"populate_by_name": True}


class RefreshResponse(BaseModel):
    success: bool = True
    data: RefreshResponseData


class TokenPayload(BaseModel):
    """Decoded JWT payload."""
    sub: str
    username: str = ""
    type: str = "access"
    iat: float = 0
    exp: float = 0
