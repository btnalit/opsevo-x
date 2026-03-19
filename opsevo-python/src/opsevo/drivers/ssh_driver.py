"""SSH device driver using asyncssh.

Requirements: 8.2
"""

from __future__ import annotations

import time
from typing import Any

import asyncssh

from opsevo.drivers.base import DeviceDriver
from opsevo.drivers.profile_loader import ProfileLoader
from opsevo.drivers.types import (
    CapabilityManifest,
    DeviceConnectionConfig,
    DeviceExecutionResult,
    DeviceMetrics,
    HealthCheckResult,
)
from opsevo.models.device import DeviceProfile
from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class SshDriver(DeviceDriver):
    """SSH driver — executes commands over SSH."""

    def __init__(self, profile: DeviceProfile) -> None:
        self._profile = profile
        self._config: DeviceConnectionConfig | None = None
        self._conn: asyncssh.SSHClientConnection | None = None

    async def connect(self, config: DeviceConnectionConfig) -> None:
        self._config = config
        self._conn = await asyncssh.connect(
            host=config.host,
            port=config.port,
            username=config.username,
            password=config.password,
            known_hosts=None,
        )
        logger.info("ssh_driver_connected", host=config.host)

    async def disconnect(self) -> None:
        if self._conn:
            self._conn.close()
            self._conn = None

    async def health_check(self) -> HealthCheckResult:
        start = time.monotonic()
        try:
            result = await self._run("echo ok")
            latency = (time.monotonic() - start) * 1000
            return HealthCheckResult(healthy=result.success, message="ok", latency_ms=latency)
        except Exception as e:
            return HealthCheckResult(healthy=False, message=str(e))

    async def query(self, action_type: str, params: dict[str, Any] | None = None) -> DeviceExecutionResult:
        cmd = (params or {}).get("command", action_type)
        return await self._run(cmd)

    async def execute(self, action_type: str, params: dict[str, Any] | None = None) -> DeviceExecutionResult:
        cmd = (params or {}).get("command", action_type)
        return await self._run(cmd)

    async def configure(self, action_type: str, params: dict[str, Any] | None = None) -> DeviceExecutionResult:
        cmd = (params or {}).get("command", action_type)
        return await self._run(cmd)

    async def monitor(self, action_type: str) -> DeviceExecutionResult:
        return await self._run(action_type)

    async def collect_metrics(self) -> DeviceMetrics:
        return DeviceMetrics()

    async def collect_data(self, data_type: str) -> DeviceExecutionResult:
        return await self._run(f"collect_{data_type}")

    def get_capability_manifest(self) -> CapabilityManifest:
        return ProfileLoader.to_capability_manifest(self._profile)

    async def _run(self, cmd: str) -> DeviceExecutionResult:
        if not self._conn:
            return DeviceExecutionResult(success=False, error="SSH not connected")
        start = time.monotonic()
        try:
            timeout = (self._config.timeout / 1000.0) if self._config else 30.0
            result = await asyncssh.wait_for(self._conn.run(cmd), timeout=timeout)
            elapsed = (time.monotonic() - start) * 1000
            if result.exit_status == 0:
                return DeviceExecutionResult(success=True, data=result.stdout, execution_time_ms=elapsed)
            return DeviceExecutionResult(
                success=False, data=result.stdout, error=result.stderr or f"exit {result.exit_status}",
                execution_time_ms=elapsed,
            )
        except Exception as e:
            elapsed = (time.monotonic() - start) * 1000
            return DeviceExecutionResult(success=False, error=str(e), execution_time_ms=elapsed)
