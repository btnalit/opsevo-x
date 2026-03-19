"""Device driver type definitions (Pydantic models).

Requirements: 8.1, 1.1, 1.2, 1.3
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from pydantic import BaseModel, Field


class DeviceConnectionConfig(BaseModel):
    host: str
    port: int = 443
    username: str = ""
    password: str = ""
    use_tls: bool = False
    timeout: int = 30000
    driver_type: str = "api"
    profile_name: str = ""


class CapabilityManifest(BaseModel):
    driver_type: str
    vendor: str = ""
    model: str = ""
    data_capabilities: list[str] = Field(default_factory=list)
    config_paths: list[str] = Field(default_factory=list)
    metrics_endpoints: dict[str, str] = Field(default_factory=dict)
    severity_mapping: dict[str, list[str]] = Field(default_factory=dict)
    remediation_templates: dict[str, str] = Field(default_factory=dict)
    script_language: str = ""


class CommandPattern(BaseModel):
    pattern: str
    description: str = ""


class DeviceMetrics(BaseModel):
    cpu_usage: float = 0.0
    memory_usage: float = 0.0
    uptime: int = 0
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class InterfaceMetrics(BaseModel):
    name: str
    rx_bytes: int = 0
    tx_bytes: int = 0
    status: str = "unknown"
    speed: str = ""


class HealthCheckResult(BaseModel):
    healthy: bool
    message: str = ""
    latency_ms: float = 0.0


class DeviceExecutionResult(BaseModel):
    success: bool
    data: Any = None
    error: str | None = None
    execution_time_ms: float = 0.0
