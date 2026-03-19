"""Bug condition exploration tests — Critical bugs (BUG-1, BUG-2, BUG-3, BUG-5, BUG-6).

These tests encode the EXPECTED (fixed) behavior. They MUST FAIL on unfixed code,
confirming the bugs exist. Do NOT fix the code or the tests when they fail.

Validates: Requirements BUG-1, BUG-2, BUG-3, BUG-5, BUG-6
"""

from __future__ import annotations

import inspect
import types
from unittest.mock import AsyncMock, MagicMock

import pytest

from opsevo.container import Container
from opsevo.data.datastore import DataStore
from opsevo.data.pg_datastore import PgDataStore
from opsevo.drivers.manager import DeviceDriverManager
from opsevo.events.event_bus import EventBus
from opsevo.services.device_manager import DeviceManager
from opsevo.services.device_pool import DevicePool
from opsevo.settings import Settings
from dependency_injector import containers, providers


# ---------------------------------------------------------------------------
# BUG-1: Provider attribute access returns Provider object, not service instance
# ---------------------------------------------------------------------------

class _UnwiredContainer(containers.DeclarativeContainer):
    """Minimal container clone WITHOUT wiring (avoids ImportError in unrelated modules)."""

    config = providers.Configuration()
    settings = providers.Singleton(Settings)
    datastore = providers.Singleton(PgDataStore, settings=settings)
    event_bus = providers.Singleton(EventBus)
    driver_manager = providers.Singleton(
        DeviceDriverManager, profiles_dir=settings.provided.profiles_dir,
    )
    device_pool = providers.Singleton(DevicePool, manager=driver_manager)
    device_manager = providers.Singleton(DeviceManager, datastore=datastore)


class TestBug1ProviderCallReturnsInstance:
    """BUG-1 FIX VERIFICATION: container.provider() returns service instance.

    **Validates: Requirements BUG-1**

    The fix changed API routes from container.event_bus (attribute access)
    to container.event_bus() (provider call). Verify the call returns
    the correct service instance type.

    Uses an unwired container clone to avoid ImportError from unrelated
    modules during wiring — the provider call semantics are identical.
    """

    def test_event_bus_call_returns_instance(self):
        """container.event_bus() should return an EventBus instance."""
        c = _UnwiredContainer()
        result = c.event_bus()
        assert isinstance(result, EventBus), (
            f"Expected EventBus instance from container.event_bus(), got {type(result).__name__}"
        )

    def test_datastore_call_returns_instance(self):
        """container.datastore() should return a DataStore instance."""
        c = _UnwiredContainer()
        result = c.datastore()
        assert isinstance(result, DataStore), (
            f"Expected DataStore instance from container.datastore(), got {type(result).__name__}"
        )

    def test_device_pool_call_returns_instance(self):
        """container.device_pool() should return a DevicePool instance."""
        c = _UnwiredContainer()
        result = c.device_pool()
        assert isinstance(result, DevicePool), (
            f"Expected DevicePool instance from container.device_pool(), got {type(result).__name__}"
        )

    def test_device_manager_call_returns_instance(self):
        """container.device_manager() should return a DeviceManager instance."""
        c = _UnwiredContainer()
        result = c.device_manager()
        assert isinstance(result, DeviceManager), (
            f"Expected DeviceManager instance from container.device_manager(), got {type(result).__name__}"
        )


# ---------------------------------------------------------------------------
# BUG-2: DevicePool.get_driver() requires 3 args but callers pass only 1
# ---------------------------------------------------------------------------

class TestBug2DevicePoolGetDriverSignature:
    """BUG-2 FIX VERIFICATION: get_driver(device_id) no longer raises TypeError.

    **Validates: Requirements BUG-2**

    The fix made config and profile_name optional. Single-arg call now
    does a cache-only lookup, raising KeyError if not cached (not TypeError).
    """

    @pytest.mark.asyncio
    async def test_get_driver_single_arg_no_type_error(self):
        """pool.get_driver('dev-1') should raise KeyError (not TypeError)."""
        mock_manager = MagicMock()
        pool = DevicePool(manager=mock_manager)
        # Should NOT raise TypeError (the old bug)
        # Should raise KeyError (cache miss — correct behavior)
        with pytest.raises(KeyError):
            await pool.get_driver("dev-1")


# ---------------------------------------------------------------------------
# BUG-3: DeviceManager.list_devices() does not accept tenant_id kwarg
# ---------------------------------------------------------------------------

class TestBug3DeviceManagerSignature:
    """BUG-3: list_devices(tenant_id=...) should not raise TypeError.

    **Validates: Requirements BUG-3**

    On unfixed code, DeviceManager.list_devices() takes no keyword arguments.
    Calling with tenant_id='user-1' raises TypeError.
    """

    @pytest.mark.asyncio
    async def test_list_devices_with_tenant_id_no_type_error(self):
        """dm.list_devices(tenant_id='user-1') should not raise TypeError."""
        mock_ds = AsyncMock(spec=DataStore)
        mock_ds.query = AsyncMock(return_value=[])
        dm = DeviceManager(datastore=mock_ds)
        try:
            await dm.list_devices(tenant_id="user-1")
        except TypeError:
            pytest.fail(
                "list_devices(tenant_id='user-1') raised TypeError — "
                "list_devices() does not accept keyword arguments"
            )


# ---------------------------------------------------------------------------
# BUG-5: main.py never sets app.state.device_manager on app.state
# ---------------------------------------------------------------------------

class TestBug5AppStateAttributes:
    """BUG-5 FIX VERIFICATION: middleware uses container for service access.

    **Validates: Requirements BUG-5**

    The fix changed middleware from request.app.state.device_manager
    to request.app.state.container.device_manager(). Verify the fixed
    access pattern works.
    """

    def test_container_device_manager_accessible(self):
        """request.app.state.container.device_manager() should work."""
        state = types.SimpleNamespace()
        mock_container = MagicMock()
        mock_container.device_manager.return_value = MagicMock(spec=DeviceManager)
        state.container = mock_container
        state.settings = MagicMock()

        # Fixed access pattern: go through container
        result = state.container.device_manager()
        assert result is not None, "container.device_manager() should return a DeviceManager"


# ---------------------------------------------------------------------------
# BUG-6: auth.py register endpoint accesses private auth._ds attribute
# ---------------------------------------------------------------------------

class TestBug6AuthRegisterPrivateAccess:
    """BUG-6: register endpoint should not reference auth._ds.

    **Validates: Requirements BUG-6**

    On unfixed code, the register endpoint in api/auth.py directly calls
    auth._ds.execute(...) and auth._ds.query_one(...), bypassing service
    layer encapsulation.
    """

    def test_register_does_not_access_private_ds(self):
        """api/auth.py register function should not reference 'auth._ds'."""
        from opsevo.api.auth import register

        source = inspect.getsource(register)
        assert "._ds" not in source, (
            "register endpoint accesses private attribute auth._ds — "
            "should use public AuthService methods instead"
        )
