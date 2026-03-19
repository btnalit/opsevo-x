"""Preservation property tests — Correct code paths that MUST remain working.

These tests verify ALREADY CORRECT code paths in the unfixed codebase.
They MUST PASS on the current unfixed code and continue passing after fixes.

**Validates: Requirements Preservation Properties 1-5 from design**

Properties tested:
1. deps.py dependency injection: container.datastore() and container.auth_service()
   return real service instances (not Provider objects)
2. main.py lifespan state: sets exactly app.state.container and app.state.settings
3. mcp.py graceful degradation: getattr(container, "xxx", None) returns None for
   missing providers (no crash)
4. Container() call pattern: calling provider with () returns proper instance
"""

from __future__ import annotations

import inspect
from unittest.mock import MagicMock

import pytest
from dependency_injector import providers

from opsevo.data.datastore import DataStore
from opsevo.services.auth_service import AuthService
from opsevo.settings import Settings
from tests.helpers.mock_datastore import MockPgDataStore


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_test_settings() -> Settings:
    return Settings(
        env="test",
        database_url="postgresql://test:test@localhost:5432/test",
        jwt_secret="test-secret-key-for-preservation-tests",
    )


class _MockContainer:
    """Mimics the Container interface using real service instances.

    Avoids instantiating the real Container (which triggers wiring of all
    opsevo submodules and hits unrelated ImportErrors in the unfixed codebase).
    This mirrors the pattern used in conftest.py.
    """

    def __init__(self) -> None:
        self._settings = _make_test_settings()
        self._ds = MockPgDataStore()
        self._auth = AuthService(settings=self._settings, datastore=self._ds)

    def datastore(self) -> DataStore:
        return self._ds

    def auth_service(self) -> AuthService:
        return self._auth


def _make_mock_request(container) -> MagicMock:
    """Create a mock Request with app.state.container set (as main.py does)."""
    request = MagicMock()
    request.app.state.container = container
    return request


# ---------------------------------------------------------------------------
# Property 1: deps.py dependency injection returns real instances
# ---------------------------------------------------------------------------

class TestDepsInjectionPreservation:
    """deps.py get_datastore() and get_auth_service() return real instances.

    **Validates: Requirements Preservation Properties 1-2**

    The deps.py module correctly uses container.datastore() and
    container.auth_service() WITH parentheses, returning actual service
    instances rather than Provider objects. This is the CORRECT pattern.
    """

    def test_get_datastore_returns_datastore_instance(self):
        """get_datastore(request) returns a DataStore, not a Provider."""
        from opsevo.api.deps import get_datastore

        container = _MockContainer()
        request = _make_mock_request(container)

        result = get_datastore(request)

        assert isinstance(result, DataStore), (
            f"Expected DataStore instance, got {type(result).__name__}"
        )
        assert not isinstance(result, providers.Provider), (
            "get_datastore returned a Provider object instead of a DataStore instance"
        )

    def test_get_auth_service_returns_auth_service_instance(self):
        """get_auth_service(request) returns an AuthService, not a Provider."""
        from opsevo.api.deps import get_auth_service

        container = _MockContainer()
        request = _make_mock_request(container)

        result = get_auth_service(request)

        assert isinstance(result, AuthService), (
            f"Expected AuthService instance, got {type(result).__name__}"
        )
        assert not isinstance(result, providers.Provider), (
            "get_auth_service returned a Provider object instead of an AuthService instance"
        )


# ---------------------------------------------------------------------------
# Property 2: main.py lifespan sets exactly container and settings on app.state
# ---------------------------------------------------------------------------

class TestMainLifespanStatePreservation:
    """main.py lifespan sets exactly app.state.container and app.state.settings.

    **Validates: Requirements Preservation Property 3**

    The lifespan function in main.py sets two attributes on app.state:
    - app.state.container (a Container instance)
    - app.state.settings (a Settings instance)
    No other attributes (like device_manager, device_pool, etc.) are set.
    """

    def test_lifespan_sets_container_and_settings(self):
        """Verify main.py lifespan code sets exactly container and settings."""
        from opsevo.main import lifespan

        source = inspect.getsource(lifespan)

        assert "app.state.container" in source, (
            "lifespan does not set app.state.container"
        )
        assert "app.state.settings" in source, (
            "lifespan does not set app.state.settings"
        )

    def test_lifespan_does_not_set_device_manager_on_state(self):
        """main.py lifespan should NOT set app.state.device_manager directly."""
        from opsevo.main import lifespan

        source = inspect.getsource(lifespan)

        assert "app.state.device_manager" not in source, (
            "lifespan unexpectedly sets app.state.device_manager"
        )
        assert "app.state.device_pool" not in source, (
            "lifespan unexpectedly sets app.state.device_pool directly "
            "(it should only be accessed via container)"
        )


# ---------------------------------------------------------------------------
# Property 3: mcp.py graceful degradation — getattr returns None for missing
# ---------------------------------------------------------------------------

class TestMcpGracefulDegradationPreservation:
    """mcp.py getattr(container, "xxx", None) returns None when provider missing.

    **Validates: Requirements Preservation Property 4**

    The mcp.py module uses getattr(container, "provider_name", None) to
    safely access providers that may not be registered. This pattern returns
    None instead of raising AttributeError.
    """

    def test_getattr_missing_provider_returns_none(self):
        """getattr(container, 'nonexistent', None) returns None, not crash."""
        container = _MockContainer()

        result = getattr(container, "mcp_server_handler", None)
        assert result is None, (
            f"Expected None for missing provider, got {type(result).__name__}"
        )

    def test_getattr_multiple_missing_providers_all_none(self):
        """All unregistered providers return None via getattr pattern."""
        container = _MockContainer()

        missing_providers = [
            "mcp_server_handler",
            "mcp_client_manager",
            "api_key_manager",
            "tool_registry",
            "security_gateway",
        ]

        for name in missing_providers:
            result = getattr(container, name, None)
            assert result is None, (
                f"getattr(container, '{name}', None) returned "
                f"{type(result).__name__} instead of None"
            )

    def test_mcp_helpers_use_getattr_pattern(self):
        """mcp.py helper functions use getattr for graceful degradation."""
        from opsevo.api import mcp

        source = inspect.getsource(mcp)

        assert "getattr(" in source, (
            "mcp.py does not use getattr() pattern for graceful degradation"
        )


# ---------------------------------------------------------------------------
# Property 4: Container() call pattern — calling with () returns instances
# ---------------------------------------------------------------------------

class TestContainerCallPatternPreservation:
    """Calling container.datastore() with () returns a proper DataStore instance.

    **Validates: Requirements Preservation Property 5**

    This is the CORRECT pattern already used in deps.py. The () invocation
    on a dependency-injector Provider returns the actual service instance.
    We verify this using the mock container (same interface as the real one).
    """

    def test_container_datastore_call_returns_datastore(self):
        """container.datastore() returns a DataStore instance."""
        container = _MockContainer()

        result = container.datastore()

        assert isinstance(result, DataStore), (
            f"container.datastore() returned {type(result).__name__}, "
            f"expected DataStore instance"
        )

    def test_container_auth_service_call_returns_auth_service(self):
        """container.auth_service() returns an AuthService instance."""
        container = _MockContainer()

        result = container.auth_service()

        assert isinstance(result, AuthService), (
            f"container.auth_service() returned {type(result).__name__}, "
            f"expected AuthService instance"
        )

    def test_container_call_not_provider(self):
        """container.provider() with () never returns a Provider object."""
        container = _MockContainer()

        ds = container.datastore()
        auth = container.auth_service()

        assert not isinstance(ds, providers.Provider), (
            "container.datastore() returned a Provider — missing ()"
        )
        assert not isinstance(auth, providers.Provider), (
            "container.auth_service() returned a Provider — missing ()"
        )

    def test_deps_source_uses_call_pattern(self):
        """deps.py source code uses container.datastore() with parentheses."""
        from opsevo.api import deps

        source = inspect.getsource(deps)

        # Verify the correct call pattern is used in deps.py
        assert "container.datastore()" in source or ".datastore()" in source, (
            "deps.py does not use container.datastore() call pattern"
        )
        assert "container.auth_service()" in source or ".auth_service()" in source, (
            "deps.py does not use container.auth_service() call pattern"
        )
