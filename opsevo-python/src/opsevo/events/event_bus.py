"""Async publish/subscribe EventBus with schema validation and fault isolation.

Requirements: 7.1, 7.2, 7.3, 7.4
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any, Callable, Awaitable

from opsevo.events.types import EventType, PerceptionEvent
from opsevo.utils.logger import get_logger

logger = get_logger(__name__)

Subscriber = Callable[[PerceptionEvent], Awaitable[None]]


class EventBus:
    """Async event bus with type-filtered subscriptions and fault isolation."""

    def __init__(self) -> None:
        # event_type -> list of callbacks; None key = wildcard subscribers
        self._subscribers: dict[EventType | None, list[Subscriber]] = defaultdict(list)
        self._sources: dict[str, dict[str, Any]] = {}
        self._published_count: int = 0

    def subscribe(self, event_type: EventType | None, callback: Subscriber) -> None:
        """Subscribe to events of *event_type*. Pass ``None`` for all events."""
        self._subscribers[event_type].append(callback)

    def unsubscribe(self, event_type: EventType | None, callback: Subscriber) -> None:
        """Remove a previously registered subscriber."""
        subs = self._subscribers.get(event_type, [])
        try:
            subs.remove(callback)
        except ValueError:
            pass

    async def publish(self, event: PerceptionEvent) -> PerceptionEvent:
        """Validate and dispatch *event* to matching subscribers.

        Schema validation rejects events missing required fields.
        Each subscriber is called in isolation — one failure does not
        prevent others from receiving the event.
        """
        self._validate(event)
        self._published_count += 1

        # Collect targeted + wildcard subscribers
        targets = list(self._subscribers.get(event.type, []))
        targets.extend(self._subscribers.get(None, []))

        for sub in targets:
            try:
                await sub(event)
            except Exception:
                logger.error(
                    "subscriber_error",
                    event_type=event.type.value,
                    event_id=event.event_id,
                    exc_info=True,
                )

        return event

    def register_source(self, source_name: str, metadata: dict[str, Any]) -> None:
        """Register a perception source with metadata."""
        self._sources[source_name] = metadata
        logger.info("source_registered", source=source_name)

    @property
    def registered_sources(self) -> dict[str, dict[str, Any]]:
        return dict(self._sources)

    @property
    def published_count(self) -> int:
        return self._published_count

    @property
    def subscriber_count(self) -> int:
        return sum(len(subs) for subs in self._subscribers.values())

    @staticmethod
    def _validate(event: PerceptionEvent) -> None:
        """Reject events missing required fields."""
        errors: list[str] = []
        if not event.type:
            errors.append("type")
        if not event.priority:
            errors.append("priority")
        if not event.source:
            errors.append("source")
        if event.payload is None:
            errors.append("payload")
        if not event.schema_version:
            errors.append("schema_version")
        if errors:
            raise ValueError(f"PerceptionEvent missing required fields: {errors}")
