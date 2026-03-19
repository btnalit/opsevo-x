"""Profile loader — reads YAML/JSON device profiles from disk.

Requirements: 8.3, 8.4
"""

from __future__ import annotations

from pathlib import Path

import yaml

from opsevo.drivers.types import CapabilityManifest
from opsevo.models.device import DeviceProfile
from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class ProfileLoader:
    """Load device driver profiles from a directory."""

    @staticmethod
    def load_profile(path: str | Path) -> DeviceProfile:
        """Load a single profile from a YAML or JSON file."""
        p = Path(path)
        text = p.read_text(encoding="utf-8")
        if p.suffix in (".yaml", ".yml"):
            data = yaml.safe_load(text)
        else:
            import json
            data = json.loads(text)
        return DeviceProfile(**data)

    @staticmethod
    def load_all(profiles_dir: str | Path) -> dict[str, DeviceProfile]:
        """Load all profiles from a directory. Key = filename stem."""
        root = Path(profiles_dir)
        profiles: dict[str, DeviceProfile] = {}
        if not root.is_dir():
            logger.warning("profiles_dir_missing", path=str(root))
            return profiles
        for f in sorted(root.iterdir()):
            if f.suffix in (".yaml", ".yml", ".json"):
                try:
                    profiles[f.stem] = ProfileLoader.load_profile(f)
                    logger.info("profile_loaded", name=f.stem)
                except Exception:
                    logger.error("profile_load_failed", path=str(f), exc_info=True)
        return profiles

    @staticmethod
    def to_capability_manifest(profile: DeviceProfile) -> CapabilityManifest:
        """Convert a DeviceProfile to a CapabilityManifest."""
        return CapabilityManifest(
            driver_type=profile.driver_type,
            vendor=profile.vendor,
            model=profile.model,
            data_capabilities=profile.data_capabilities,
            config_paths=profile.config_paths,
            metrics_endpoints=profile.metrics_endpoints,
            severity_mapping=profile.severity_mapping,
            remediation_templates=profile.remediation_templates,
            script_language=profile.script_language,
        )
