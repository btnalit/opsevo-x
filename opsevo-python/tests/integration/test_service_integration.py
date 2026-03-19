"""Core service integration tests.

Tests full service flows end-to-end using MockPgDataStore:
1. AuthService: register → login → verify token → refresh
2. DeviceManager: create → list → update → delete
3. EventBus: publish → subscriber chain

Validates: Requirements 23.4
"""

from __future__ import annotations

import pytest

from opsevo.events.event_bus import EventBus
from opsevo.events.types import EventType, PerceptionEvent, Priority
from opsevo.services.auth_service import AuthService
from opsevo.services.device_manager import DeviceManager
from opsevo.settings import Settings
from tests.helpers.mock_datastore import MockPgDataStore


def _settings() -> Settings:
    return Settings(
        env="test",
        database_url="postgresql://test:test@localhost:5432/test",
        jwt_secret="integration-test-secret-32chars!!",
    )


# ── AuthService full flow ─────────────────────────────────────────────────

class TestAuthServiceFlow:

    @pytest.mark.asyncio
    async def test_register_login_verify_refresh(self):
        ds = MockPgDataStore()
        auth = AuthService(settings=_settings(), datastore=ds)

        # 1. Register
        user = await auth.create_user("alice", "alice@test.com", "s3cret!")
        assert user["username"] == "alice"
        assert user["email"] == "alice@test.com"
        assert "password_hash" in user

        # 2. Login (authenticate)
        authed = await auth.authenticate("alice", "s3cret!")
        assert authed is not None
        assert authed["username"] == "alice"

        # 3. Generate + verify access token
        token = auth.generate_access_token(user["id"], "alice")
        payload = auth.verify_token(token)
        assert payload["sub"] == user["id"]
        assert payload["username"] == "alice"
        assert payload["type"] == "access"

        # 4. Generate + verify refresh token
        refresh = auth.generate_refresh_token(user["id"])
        rpayload = auth.verify_token(refresh)
        assert rpayload["sub"] == user["id"]
        assert rpayload["type"] == "refresh"

    @pytest.mark.asyncio
    async def test_wrong_password_rejected(self):
        ds = MockPgDataStore()
        auth = AuthService(settings=_settings(), datastore=ds)

        await auth.create_user("bob", "bob@test.com", "correct")
        result = await auth.authenticate("bob", "wrong")
        assert result is None

    @pytest.mark.asyncio
    async def test_nonexistent_user_rejected(self):
        ds = MockPgDataStore()
        auth = AuthService(settings=_settings(), datastore=ds)

        result = await auth.authenticate("ghost", "pass")
        assert result is None

    @pytest.mark.asyncio
    async def test_get_user_by_id(self):
        ds = MockPgDataStore()
        auth = AuthService(settings=_settings(), datastore=ds)

        user = await auth.create_user("carol", "carol@test.com", "pass")
        found = await auth.get_user_by_id(user["id"])
        assert found is not None
        assert found["username"] == "carol"


# ── DeviceManager CRUD ────────────────────────────────────────────────────

class TestDeviceManagerCRUD:

    @pytest.mark.asyncio
    async def test_create_list_update_delete(self):
        ds = MockPgDataStore()
        dm = DeviceManager(datastore=ds)

        # 1. Create
        dev = await dm.create_device({
            "name": "router-1",
            "host": "192.168.1.1",
            "port": 8728,
            "driver_type": "api",
        })
        assert dev is not None
        assert dev["name"] == "router-1"
        device_id = dev["id"]

        # 2. List
        devices = await dm.list_devices()
        assert len(devices) == 1
        assert devices[0]["host"] == "192.168.1.1"

        # 3. Update
        updated = await dm.update_device(device_id, {"name": "router-1-updated"})
        assert updated is not None
        assert updated["name"] == "router-1-updated"

        # 4. Delete
        deleted = await dm.delete_device(device_id)
        assert deleted == 1

        # 5. Verify empty
        devices = await dm.list_devices()
        assert len(devices) == 0

    @pytest.mark.asyncio
    async def test_get_nonexistent_device(self):
        ds = MockPgDataStore()
        dm = DeviceManager(datastore=ds)

        result = await dm.get_device("no-such-id")
        assert result is None

    @pytest.mark.asyncio
    async def test_create_with_tenant_id(self):
        ds = MockPgDataStore()
        dm = DeviceManager(datastore=ds)

        dev = await dm.create_device(
            {"name": "switch-1", "host": "10.0.0.1"},
            tenant_id="tenant-abc",
        )
        assert dev is not None
        assert dev["tenant_id"] == "tenant-abc"

        # List by tenant
        devices = await dm.list_devices(tenant_id="tenant-abc")
        assert len(devices) == 1

    @pytest.mark.asyncio
    async def test_update_with_empty_data_returns_current(self):
        ds = MockPgDataStore()
        dm = DeviceManager(datastore=ds)

        dev = await dm.create_device({"name": "ap-1", "host": "10.0.0.2"})
        device_id = dev["id"]

        # Update with no allowed fields → returns current device
        result = await dm.update_device(device_id, {"bogus_field": "ignored"})
        # Should return the existing device unchanged
        assert result is not None


# ── EventBus subscriber chain ─────────────────────────────────────────────

class TestEventBusChain:

    @pytest.mark.asyncio
    async def test_publish_reaches_all_subscribers(self):
        eb = EventBus()
        received: list[str] = []

        async def sub_a(event: PerceptionEvent):
            received.append(f"a:{event.payload['msg']}")

        async def sub_b(event: PerceptionEvent):
            received.append(f"b:{event.payload['msg']}")

        eb.subscribe(EventType.ALERT, sub_a)
        eb.subscribe(EventType.ALERT, sub_b)

        await eb.publish(PerceptionEvent(
            type=EventType.ALERT,
            priority=Priority.HIGH,
            source="test",
            payload={"msg": "hello"},
            schema_version="1.0",
        ))

        assert "a:hello" in received
        assert "b:hello" in received
        assert len(received) == 2

    @pytest.mark.asyncio
    async def test_wildcard_subscriber_receives_all_types(self):
        eb = EventBus()
        received: list[EventType] = []

        async def wildcard(event: PerceptionEvent):
            received.append(event.type)

        eb.subscribe(None, wildcard)

        for etype in [EventType.ALERT, EventType.METRIC, EventType.SYSLOG]:
            await eb.publish(PerceptionEvent(
                type=etype, priority=Priority.LOW,
                source="test", payload={}, schema_version="1.0",
            ))

        assert received == [EventType.ALERT, EventType.METRIC, EventType.SYSLOG]

    @pytest.mark.asyncio
    async def test_failing_subscriber_does_not_block_others(self):
        eb = EventBus()
        received: list[str] = []

        async def bad_sub(event: PerceptionEvent):
            raise RuntimeError("I fail")

        async def good_sub(event: PerceptionEvent):
            received.append("ok")

        eb.subscribe(EventType.METRIC, bad_sub)
        eb.subscribe(EventType.METRIC, good_sub)

        await eb.publish(PerceptionEvent(
            type=EventType.METRIC, priority=Priority.MEDIUM,
            source="test", payload={"val": 42}, schema_version="1.0",
        ))

        assert received == ["ok"]

    @pytest.mark.asyncio
    async def test_unsubscribe_stops_delivery(self):
        eb = EventBus()
        received: list[str] = []

        async def sub(event: PerceptionEvent):
            received.append("got")

        eb.subscribe(EventType.INTERNAL, sub)
        await eb.publish(PerceptionEvent(
            type=EventType.INTERNAL, priority=Priority.INFO,
            source="test", payload={}, schema_version="1.0",
        ))
        assert len(received) == 1

        eb.unsubscribe(EventType.INTERNAL, sub)
        await eb.publish(PerceptionEvent(
            type=EventType.INTERNAL, priority=Priority.INFO,
            source="test", payload={}, schema_version="1.0",
        ))
        assert len(received) == 1  # no new delivery
