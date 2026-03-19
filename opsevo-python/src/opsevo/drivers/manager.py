"""DeviceDriverManager — factory registration and driver instance management.

Requirements: 8.5
"""

from __future__ import annotations

from typing import Any

from opsevo.drivers.api_driver import ApiDriver
from opsevo.drivers.base import DeviceDriver
from opsevo.drivers.profile_loader import ProfileLoader
from opsevo.drivers.ssh_driver import SshDriver
from opsevo.drivers.snmp_driver import SnmpDriver
from opsevo.drivers.types import DeviceConnectionConfig
from opsevo.models.device import DeviceProfile
from opsevo.utils.logger import get_logger

logger = get_logger(__name__)

_DRIVER_MAP: dict[str, type[DeviceDriver]] = {
    "api": ApiDriver,
    "ssh": SshDriver,
    "snmp": SnmpDriver,
}


class DeviceDriverManager:
    """Manages driver factories and creates driver instances from profiles."""

    def __init__(self, profiles_dir: str = "profiles") -> None:
        self._profiles: dict[str, DeviceProfile] = {}
        self._profiles_dir = profiles_dir

    def load_profiles(self) -> None:
        self._profiles = ProfileLoader.load_all(self._profiles_dir)
        logger.info("profiles_loaded", count=len(self._profiles))

    def get_profile(self, name: str) -> DeviceProfile | None:
        return self._profiles.get(name)

    @property
    def profiles(self) -> dict[str, DeviceProfile]:
        return dict(self._profiles)

    def create_driver(self, profile_name: str) -> DeviceDriver:
        profile = self._profiles.get(profile_name)
        if not profile:
            raise ValueError(f"Unknown profile: {profile_name}")
        driver_cls = _DRIVER_MAP.get(profile.driver_type)
        if not driver_cls:
            raise ValueError(f"Unsupported driver_type: {profile.driver_type}")
        return driver_cls(profile)

    def create_driver_from_profile(self, profile: DeviceProfile) -> DeviceDriver:
        driver_cls = _DRIVER_MAP.get(profile.driver_type)
        if not driver_cls:
            raise ValueError(f"Unsupported driver_type: {profile.driver_type}")
        return driver_cls(profile)

    @staticmethod
    def register_driver_type(driver_type: str, driver_cls: type[DeviceDriver]) -> None:
        _DRIVER_MAP[driver_type] = driver_cls
