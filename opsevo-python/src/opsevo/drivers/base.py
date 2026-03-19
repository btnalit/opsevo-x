"""DeviceDriver and DeviceDriverFactory abstract base classes.

Requirements: 8.1, 8.2
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

from opsevo.drivers.types import (
    CapabilityManifest,
    DeviceConnectionConfig,
    DeviceExecutionResult,
    DeviceMetrics,
    HealthCheckResult,
)


class DeviceDriver(ABC):
    """Abstract interface for all device drivers (API, SSH, SNMP, etc.)."""

    @abstractmethod
    async def connect(self, config: DeviceConnectionConfig) -> None: ...

    @abstractmethod
    async def disconnect(self) -> None: ...

    @abstractmethod
    async def health_check(self) -> HealthCheckResult: ...

    @abstractmethod
    async def query(self, action_type: str, params: dict[str, Any] | None = None) -> DeviceExecutionResult: ...

    @abstractmethod
    async def execute(self, action_type: str, params: dict[str, Any] | None = None) -> DeviceExecutionResult: ...

    @abstractmethod
    async def configure(self, action_type: str, params: dict[str, Any] | None = None) -> DeviceExecutionResult: ...

    @abstractmethod
    async def monitor(self, action_type: str) -> DeviceExecutionResult: ...

    @abstractmethod
    async def collect_metrics(self) -> DeviceMetrics: ...

    @abstractmethod
    async def collect_data(self, data_type: str) -> DeviceExecutionResult: ...

    @abstractmethod
    def get_capability_manifest(self) -> CapabilityManifest: ...


class DeviceDriverFactory(ABC):
    """Factory for creating DeviceDriver instances."""

    @abstractmethod
    def create_driver(self, config: DeviceConnectionConfig, profile: Any) -> DeviceDriver: ...

    @abstractmethod
    def supports_driver_type(self, driver_type: str) -> bool: ...
