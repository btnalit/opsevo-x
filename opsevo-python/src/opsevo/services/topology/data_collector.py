"""
拓扑数据采集器 — 通过 DeviceDriver 收集拓扑数据

使用 DeviceDriver.collect_data('topology') 而非厂商特定命令。

Requirements: 16.1
"""

from __future__ import annotations

import asyncio
import time
from typing import Any, Protocol

import structlog

from opsevo.services.topology.types import RawDiscoveryData

logger = structlog.get_logger(__name__)


class TopologyDataClient(Protocol):
    """Protocol for device data collection."""
    async def collect_data(self, data_type: str) -> dict[str, Any]: ...


async def collect_device_data(
    device_id: str, tenant_id: str, client: TopologyDataClient,
    device_name: str | None = None, management_address: str | None = None,
) -> RawDiscoveryData:
    """从单个设备收集拓扑数据。"""
    now = time.time()
    data = RawDiscoveryData(
        device_id=device_id, tenant_id=tenant_id, timestamp=now,
        device_name=device_name, management_address=management_address,
    )
    try:
        result = await client.collect_data("topology")
        data.neighbors = result.get("neighbors", [])
        data.arp_entries = result.get("arpEntries", result.get("arp_entries", []))
        data.interfaces = result.get("interfaces", [])
        data.routes = result.get("routes", [])
        data.dhcp_leases = result.get("dhcpLeases", result.get("dhcp_leases", []))
    except Exception as exc:
        data.errors.append({"source": "topology", "error": str(exc)})
        logger.warn("Topology data collection failed", device_id=device_id, error=str(exc))
    return data


async def collect_all_devices_data(
    devices: list[dict[str, Any]],
    get_connection,
    max_concurrent: int = 2,
) -> list[RawDiscoveryData]:
    """并发收集多个设备的拓扑数据。"""
    sem = asyncio.Semaphore(max_concurrent)
    results: list[RawDiscoveryData] = []

    async def _collect_one(dev: dict[str, Any]) -> RawDiscoveryData:
        async with sem:
            client = await get_connection(dev["tenant_id"], dev["id"])
            return await collect_device_data(
                device_id=dev["id"], tenant_id=dev["tenant_id"],
                client=client, device_name=dev.get("name"),
                management_address=dev.get("host"),
            )

    tasks = [asyncio.create_task(_collect_one(d)) for d in devices]
    for task in asyncio.as_completed(tasks):
        try:
            result = await task
            results.append(result)
        except Exception as exc:
            logger.error("Device data collection error", error=str(exc))
    return results
