"""Property-based tests for EventBus subscriber isolation and schema validation.

Property 4: 订阅者隔离 — 任一订阅者抛出异常不影响其他订阅者接收同一事件
Property 5: Schema 校验完整性 — 缺少必填字段的事件必须被拒绝

Validates: Requirements 7.2, 7.3
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from hypothesis import given, settings as h_settings
from hypothesis import strategies as st

from opsevo.events.event_bus import EventBus
from opsevo.events.types import EventType, PerceptionEvent, Priority


# ── Strategies ────────────────────────────────────────────────────────────

event_types = st.sampled_from(list(EventType))
priorities = st.sampled_from(list(Priority))
sources = st.text(min_size=1, max_size=20, alphabet="abcdefghijklmnopqrstuvwxyz-_")
payloads = st.dictionaries(
    keys=st.text(min_size=1, max_size=10, alphabet="abcdefghijklmnopqrstuvwxyz"),
    values=st.one_of(st.integers(), st.text(max_size=20), st.booleans()),
    min_size=1,
    max_size=5,
)

valid_events = st.builds(
    PerceptionEvent,
    type=event_types,
    priority=priorities,
    source=sources,
    payload=payloads,
)

# Number of subscribers: some will fail, some will succeed
subscriber_counts = st.integers(min_value=2, max_value=8)
# Which subscribers should raise exceptions (as a set of indices)
failure_masks = st.lists(st.booleans(), min_size=2, max_size=8)


# ── Property 4: Subscriber Isolation ──────────────────────────────────────

class TestSubscriberIsolation:
    """One subscriber's exception must not prevent others from receiving the event."""

    @given(event=valid_events, mask=failure_masks)
    @h_settings(max_examples=30, deadline=None)
    @pytest.mark.asyncio
    async def test_failing_subscriber_does_not_block_others(
        self, event: PerceptionEvent, mask: list[bool]
    ):
        """All non-failing subscribers receive the event even when some raise."""
        bus = EventBus()
        received: list[int] = []

        for i, should_fail in enumerate(mask):
            idx = i  # capture

            async def make_sub(index: int, fail: bool):
                async def sub(evt: PerceptionEvent) -> None:
                    if fail:
                        raise RuntimeError(f"subscriber {index} intentional failure")
                    received.append(index)
                return sub

            cb = await make_sub(idx, should_fail)
            bus.subscribe(event.type, cb)

        await bus.publish(event)

        # Every non-failing subscriber should have been called
        expected = [i for i, fail in enumerate(mask) if not fail]
        assert sorted(received) == sorted(expected), (
            f"Expected subscribers {expected} to receive event, got {sorted(received)}"
        )

    @pytest.mark.asyncio
    async def test_all_subscribers_fail_no_crash(self):
        """Publishing to all-failing subscribers completes without raising."""
        bus = EventBus()

        async def bad_sub(evt: PerceptionEvent) -> None:
            raise ValueError("boom")

        bus.subscribe(EventType.ALERT, bad_sub)
        bus.subscribe(EventType.ALERT, bad_sub)

        event = PerceptionEvent(
            type=EventType.ALERT,
            priority=Priority.HIGH,
            source="test",
            payload={"msg": "test"},
        )
        # Should not raise
        result = await bus.publish(event)
        assert result.event_id == event.event_id

    @pytest.mark.asyncio
    async def test_wildcard_and_typed_subscribers_both_called(self):
        """Both type-specific and wildcard subscribers receive the event."""
        bus = EventBus()
        typed_received = []
        wildcard_received = []

        async def typed_sub(evt: PerceptionEvent) -> None:
            typed_received.append(evt.event_id)

        async def wildcard_sub(evt: PerceptionEvent) -> None:
            wildcard_received.append(evt.event_id)

        bus.subscribe(EventType.METRIC, typed_sub)
        bus.subscribe(None, wildcard_sub)  # wildcard

        event = PerceptionEvent(
            type=EventType.METRIC,
            priority=Priority.LOW,
            source="test",
            payload={"cpu": 50},
        )
        await bus.publish(event)

        assert len(typed_received) == 1
        assert len(wildcard_received) == 1
        assert typed_received[0] == event.event_id
        assert wildcard_received[0] == event.event_id


# ── Property 5: Schema Validation Completeness ───────────────────────────

class TestSchemaValidation:
    """Events missing required fields must be rejected by publish()."""

    @pytest.mark.asyncio
    async def test_missing_type_rejected(self):
        """Event with type=None is rejected."""
        bus = EventBus()
        event = PerceptionEvent(
            type=EventType.ALERT,
            priority=Priority.HIGH,
            source="test",
            payload={"x": 1},
        )
        # Manually break the type field
        object.__setattr__(event, "type", None)
        with pytest.raises(ValueError, match="type"):
            await bus.publish(event)

    @pytest.mark.asyncio
    async def test_missing_priority_rejected(self):
        """Event with priority=None is rejected."""
        bus = EventBus()
        event = PerceptionEvent(
            type=EventType.ALERT,
            priority=Priority.HIGH,
            source="test",
            payload={"x": 1},
        )
        object.__setattr__(event, "priority", None)
        with pytest.raises(ValueError, match="priority"):
            await bus.publish(event)

    @pytest.mark.asyncio
    async def test_missing_source_rejected(self):
        """Event with source='' is rejected."""
        bus = EventBus()
        event = PerceptionEvent(
            type=EventType.ALERT,
            priority=Priority.HIGH,
            source="",
            payload={"x": 1},
        )
        with pytest.raises(ValueError, match="source"):
            await bus.publish(event)

    @pytest.mark.asyncio
    async def test_missing_payload_rejected(self):
        """Event with payload=None is rejected."""
        bus = EventBus()
        event = PerceptionEvent(
            type=EventType.ALERT,
            priority=Priority.HIGH,
            source="test",
            payload={"x": 1},
        )
        object.__setattr__(event, "payload", None)
        with pytest.raises(ValueError, match="payload"):
            await bus.publish(event)

    @pytest.mark.asyncio
    async def test_missing_schema_version_rejected(self):
        """Event with schema_version='' is rejected."""
        bus = EventBus()
        event = PerceptionEvent(
            type=EventType.ALERT,
            priority=Priority.HIGH,
            source="test",
            payload={"x": 1},
            schema_version="",
        )
        with pytest.raises(ValueError, match="schema_version"):
            await bus.publish(event)

    @given(event=valid_events)
    @h_settings(max_examples=20)
    @pytest.mark.asyncio
    async def test_valid_events_always_accepted(self, event: PerceptionEvent):
        """A fully valid event is never rejected by schema validation."""
        bus = EventBus()
        result = await bus.publish(event)
        assert result.event_id == event.event_id
        assert bus.published_count >= 1

    @pytest.mark.asyncio
    async def test_unsubscribe_removes_subscriber(self):
        """After unsubscribe, the callback is no longer called."""
        bus = EventBus()
        received = []

        async def sub(evt: PerceptionEvent) -> None:
            received.append(evt.event_id)

        bus.subscribe(EventType.ALERT, sub)
        bus.unsubscribe(EventType.ALERT, sub)

        event = PerceptionEvent(
            type=EventType.ALERT,
            priority=Priority.HIGH,
            source="test",
            payload={"x": 1},
        )
        await bus.publish(event)
        assert len(received) == 0
