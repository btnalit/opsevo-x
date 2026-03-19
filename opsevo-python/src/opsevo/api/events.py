"""Events & Webhook API routes.

POST /api/v1/events/webhook
GET  /api/v1/events/status
GET  /api/v1/events

Requirements: 3.1, 15.2
"""

from __future__ import annotations

import time
import uuid

from fastapi import APIRouter, Depends, Request

from opsevo.api.deps import get_current_user
from opsevo.events.types import EventType, PerceptionEvent, Priority
from opsevo.models.common import SuccessResponse
from opsevo.models.events import (
    EventStatusResponse,
    PerceptionEventCreate,
    PerceptionEventResponse,
    WebhookPayload,
)

router = APIRouter(prefix="/api/events", tags=["events"])


@router.post("/webhook")
async def receive_webhook(
    body: WebhookPayload,
    request: Request,
):
    event_bus = request.app.state.container.event_bus()
    event = PerceptionEvent(
        type=EventType.WEBHOOK,
        priority=Priority.MEDIUM,
        source=body.source or "webhook",
        payload=body.data,
    )
    published = await event_bus.publish(event)
    return {
        "success": True,
        "data": {"eventId": published.event_id},
    }


@router.get("/status")
async def events_status(
    request: Request,
    user: dict = Depends(get_current_user),
):
    event_bus = request.app.state.container.event_bus()
    return EventStatusResponse(
        data={
            "published": event_bus.published_count,
            "subscribers": event_bus.subscriber_count,
        },
    ).model_dump()


@router.post("")
async def create_event(
    body: PerceptionEventCreate,
    request: Request,
    user: dict = Depends(get_current_user),
):
    event_bus = request.app.state.container.event_bus()
    event = PerceptionEvent(
        type=body.type,
        priority=body.priority,
        source=body.source,
        payload=body.payload,
        schema_version=body.schema_version,
    )
    published = await event_bus.publish(event)
    return SuccessResponse(
        data=PerceptionEventResponse(
            id=published.event_id,
            type=published.type,
            priority=published.priority,
            source=published.source,
            timestamp=published.timestamp.timestamp(),
            payload=published.payload,
            schemaVersion=published.schema_version,
        ).model_dump(by_alias=True),
    ).model_dump()
