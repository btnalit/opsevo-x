"""Common / shared Pydantic models.

Requirements: 2.3, 3.2
"""

from __future__ import annotations

from typing import Any, Generic, TypeVar

from pydantic import BaseModel, Field

T = TypeVar("T")


# ── Generic API Envelope ──────────────────────────────────────────────────

class SuccessResponse(BaseModel, Generic[T]):
    success: bool = True
    data: T


class ErrorResponse(BaseModel):
    success: bool = False
    error: str = ""
    code: str = ""


class MessageResponse(BaseModel):
    success: bool = True
    message: str = ""


# ── Pagination ────────────────────────────────────────────────────────────

class PaginationParams(BaseModel):
    page: int = Field(default=1, ge=1)
    page_size: int = Field(default=20, ge=1, le=200, alias="pageSize")
    sort_by: str = Field(default="created_at", alias="sortBy")
    sort_order: str = Field(default="desc", alias="sortOrder")

    model_config = {"populate_by_name": True}


class PaginatedData(BaseModel, Generic[T]):
    items: list[T] = Field(default_factory=list)
    total: int = 0
    page: int = 1
    page_size: int = Field(default=20, alias="pageSize")
    total_pages: int = Field(default=0, alias="totalPages")

    model_config = {"populate_by_name": True}


class PaginatedResponse(BaseModel, Generic[T]):
    success: bool = True
    data: PaginatedData[T]


# ── Health Check ──────────────────────────────────────────────────────────

class ServiceHealth(BaseModel):
    name: str
    status: str = "unknown"  # healthy | degraded | unhealthy | unknown
    latency_ms: float = Field(default=0.0, alias="latencyMs")
    message: str = ""

    model_config = {"populate_by_name": True}


class HealthResponse(BaseModel):
    status: str = "ok"
    timestamp: str = ""
    services: dict[str, Any] = Field(default_factory=dict)


# ── Batch Operations ─────────────────────────────────────────────────────

class BatchDeleteRequest(BaseModel):
    ids: list[str]


class BatchResult(BaseModel):
    success: bool = True
    deleted: int = 0
    failed: int = 0
