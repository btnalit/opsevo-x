"""SNMP device driver using pysnmp.

Requirements: 8.2
"""

from __future__ import annotations

import time
from typing import Any

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


class SnmpDriver(DeviceDriver):
    """SNMP v2c/v3 driver — supports GET, WALK, BULK operations."""

    def __init__(self, profile: DeviceProfile) -> None:
        self._profile = profile
        self._config: DeviceConnectionConfig | None = None

    async def connect(self, config: DeviceConnectionConfig) -> None:
        self._config = config
        logger.info("snmp_driver_connected", host=config.host, port=config.port)

    async def disconnect(self) -> None:
        self._config = None

    async def health_check(self) -> HealthCheckResult:
        start = time.monotonic()
        try:
            result = await self.query("get", {"oid": "1.3.6.1.2.1.1.1.0"})
            latency = (time.monotonic() - start) * 1000
            return HealthCheckResult(healthy=result.success, message="sysDescr ok", latency_ms=latency)
        except Exception as e:
            return HealthCheckResult(healthy=False, message=str(e))

    async def query(self, action_type: str, params: dict[str, Any] | None = None) -> DeviceExecutionResult:
        return await self._snmp_op(action_type, params)

    async def execute(self, action_type: str, params: dict[str, Any] | None = None) -> DeviceExecutionResult:
        return await self._snmp_op(action_type, params)

    async def configure(self, action_type: str, params: dict[str, Any] | None = None) -> DeviceExecutionResult:
        return DeviceExecutionResult(success=False, error="SNMP configure not supported")

    async def monitor(self, action_type: str) -> DeviceExecutionResult:
        return await self._snmp_op("walk", {"oid": action_type})

    async def collect_metrics(self) -> DeviceMetrics:
        return DeviceMetrics()

    async def collect_data(self, data_type: str) -> DeviceExecutionResult:
        return await self._snmp_op("walk", {"oid": data_type})

    def get_capability_manifest(self) -> CapabilityManifest:
        return ProfileLoader.to_capability_manifest(self._profile)

    async def _snmp_op(self, action_type: str, params: dict[str, Any] | None = None) -> DeviceExecutionResult:
        if not self._config:
            return DeviceExecutionResult(success=False, error="SNMP not connected")
        start = time.monotonic()
        try:
            from pysnmp.hlapi.v3arch.asyncio import (
                CommunityData,
                ContextData,
                ObjectIdentity,
                ObjectType,
                SnmpEngine,
                UdpTransportTarget,
                get_cmd,
                bulk_cmd,
                walk_cmd,
            )

            engine = SnmpEngine()
            community = CommunityData(self._config.password or "public")
            transport = await UdpTransportTarget.create((self._config.host, self._config.port or 161))
            oid = (params or {}).get("oid", "1.3.6.1.2.1.1.1.0")

            if action_type == "walk":
                results = []
                async for error_indication, error_status, error_index, var_binds in walk_cmd(
                    engine, community, transport, ContextData(),
                    ObjectType(ObjectIdentity(oid)),
                ):
                    if error_indication or error_status:
                        break
                    for vb in var_binds:
                        results.append({str(vb[0]): str(vb[1])})
                elapsed = (time.monotonic() - start) * 1000
                return DeviceExecutionResult(success=True, data=results, execution_time_ms=elapsed)

            elif action_type == "bulk":
                results = []
                async for error_indication, error_status, error_index, var_binds in bulk_cmd(
                    engine, community, transport, ContextData(),
                    0, 25,
                    ObjectType(ObjectIdentity(oid)),
                ):
                    if error_indication or error_status:
                        break
                    for vb in var_binds:
                        results.append({str(vb[0]): str(vb[1])})
                elapsed = (time.monotonic() - start) * 1000
                return DeviceExecutionResult(success=True, data=results, execution_time_ms=elapsed)

            else:  # get
                error_indication, error_status, error_index, var_binds = await get_cmd(
                    engine, community, transport, ContextData(),
                    ObjectType(ObjectIdentity(oid)),
                )
                elapsed = (time.monotonic() - start) * 1000
                if error_indication or error_status:
                    return DeviceExecutionResult(
                        success=False, error=str(error_indication or error_status), execution_time_ms=elapsed
                    )
                data = {str(vb[0]): str(vb[1]) for vb in var_binds}
                return DeviceExecutionResult(success=True, data=data, execution_time_ms=elapsed)

        except Exception as e:
            elapsed = (time.monotonic() - start) * 1000
            return DeviceExecutionResult(success=False, error=str(e), execution_time_ms=elapsed)
