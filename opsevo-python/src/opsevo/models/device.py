"""Device profile and API Pydantic models.

Requirements: 2.3, 3.2, 8.3, 8.4
"""

from __future__ import annotations

from pydantic import BaseModel, Field


# ── API Request / Response ────────────────────────────────────────────────

class DeviceCreate(BaseModel):
    name: str
    host: str
    port: int = 8728
    username: str
    password: str
    driver_type: str = Field(default="api", alias="driverType")
    profile_id: str = Field(default="", alias="profileId")
    use_tls: bool = Field(default=False, alias="useTls")

    model_config = {"populate_by_name": True}


class DeviceUpdate(BaseModel):
    name: str | None = None
    host: str | None = None
    port: int | None = None
    username: str | None = None
    password: str | None = None
    driver_type: str | None = Field(default=None, alias="driverType")
    profile_id: str | None = Field(default=None, alias="profileId")
    use_tls: bool | None = Field(default=None, alias="useTls")

    model_config = {"populate_by_name": True}


class DeviceResponse(BaseModel):
    id: str
    tenant_id: str = Field(default="", alias="tenantId")
    name: str
    host: str
    port: int
    username: str = ""
    driver_type: str = Field(default="api", alias="driverType")
    profile_id: str = Field(default="", alias="profileId")
    use_tls: bool = Field(default=False, alias="useTls")
    status: str = "offline"  # online | offline | error | connecting
    status_message: str | None = Field(default=None, alias="statusMessage")
    created_at: str = Field(default="", alias="createdAt")
    updated_at: str = Field(default="", alias="updatedAt")

    model_config = {"populate_by_name": True}


# ── Profile Models ────────────────────────────────────────────────────────


class ProfileAuth(BaseModel):
    type: str = "basic"
    username: str = ""
    password: str = ""


class ProfileEndpoint(BaseModel):
    action_type: str
    path: str
    method: str = "GET"
    read_only: bool = True
    risk_level: str = "low"
    response_transform: str | None = None


class DeviceProfile(BaseModel):
    vendor: str
    model: str
    driver_type: str = "api"
    base_url: str = ""
    auth: ProfileAuth = Field(default_factory=ProfileAuth)
    timeout: int = 30000
    endpoints: list[ProfileEndpoint] = Field(default_factory=list)
    metrics_endpoints: dict[str, str] = Field(default_factory=dict)
    data_capabilities: list[str] = Field(default_factory=list)
    config_paths: list[str] = Field(default_factory=list)
    severity_mapping: dict[str, list[str]] = Field(default_factory=dict)
    remediation_templates: dict[str, str] = Field(default_factory=dict)
    script_language: str = ""
