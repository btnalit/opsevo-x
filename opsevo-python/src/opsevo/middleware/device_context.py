"""Device context middleware — injects device driver into request.

Requirements: 8.6
"""

from __future__ import annotations

from fastapi import HTTPException, Request

from opsevo.drivers.base import DeviceDriver
from opsevo.drivers.types import DeviceConnectionConfig
from opsevo.services.device_manager import DeviceManager
from opsevo.services.device_pool import DevicePool


async def get_device_context(request: Request, device_id: str) -> DeviceDriver:
    """Resolve device_id to a connected DeviceDriver via DevicePool.

    Reads device record from DB, builds connection config, and returns
    a cached or freshly connected driver instance.
    """
    device_manager: DeviceManager = request.app.state.container.device_manager()
    device_pool: DevicePool = request.app.state.container.device_pool()

    device = await device_manager.get_device(device_id)
    if not device:
        raise HTTPException(status_code=404, detail=f"Device {device_id} not found")

    config = DeviceConnectionConfig(
        host=device.get("host", ""),
        port=device.get("port", 443),
        username=device.get("username", ""),
        password=device.get("password", ""),
        use_tls=device.get("use_tls", False),
        timeout=device.get("timeout", 30000),
        driver_type=device.get("driver_type", "api"),
        profile_name=device.get("profile_name", ""),
    )

    profile_name = config.profile_name
    if not profile_name:
        raise HTTPException(status_code=400, detail="Device has no profile_name")

    return await device_pool.get_driver(device_id, config, profile_name)
