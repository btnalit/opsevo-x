"""Event Pydantic models.

Requirements: 2.3, 3.2, 7.1
"""

from __future__ import annotations

from pydantic import BaseModel, Field

from opsevo.events.types import EventType, Priority


# ── Requests ──────────────────────────────────────────────────────────────

class PerceptionEventCreate(BaseModel):
    type: EventType
    priority: Priority
    source: str
    device_id: str | None = Field(default=None, alias="deviceId")
    payload: dict
    schema_version: str = Field(default="1.0.0", alias="schemaVersion")

    model_config = {"populate_by_name": True}


class WebhookPayload(BaseModel):
    """Generic webhook inbound payload."""
    source: str = ""
    event_type: str = Field(default="", alias="eventType")
    data: dict = Field(default_factory=dict)

    model_config = {"populate_by_name": True}


# ── Responses ─────────────────────────────────────────────────────────────

class PerceptionEventResponse(BaseModel):
    id: str
    type: EventType
    priority: Priority
    source: str
    device_id: str | None = Field(default=None, alias="deviceId")
    timestamp: float
    payload: dict
    schema_version: str = Field(default="", alias="schemaVersion")

    model_config = {"populate_by_name": True}


class EventStatusResponse(BaseModel):
    success: bool = True
    data: dict = Field(default_factory=dict)
