"""Property-based tests for Profile loading and CapabilityManifest.

Property 6: Profile Completeness — any valid Profile file loaded from the
profiles/ directory produces a CapabilityManifest with driver_type, vendor,
and data_capabilities fields populated.

Validates: Requirements 8.3, 1.2, 1.10
"""

from __future__ import annotations

from pathlib import Path

import pytest

from opsevo.drivers.profile_loader import ProfileLoader
from opsevo.drivers.types import CapabilityManifest
from opsevo.models.device import DeviceProfile

PROFILES_DIR = Path(__file__).resolve().parents[2] / "profiles"


# ── Load all profiles once ────────────────────────────────────────────────

def _all_profile_paths() -> list[Path]:
    if not PROFILES_DIR.is_dir():
        return []
    return sorted(
        p for p in PROFILES_DIR.iterdir()
        if p.suffix in (".yaml", ".yml", ".json")
    )


PROFILE_PATHS = _all_profile_paths()


# ── Property: every profile loads successfully ────────────────────────────

class TestProfileLoading:

    @pytest.mark.parametrize("path", PROFILE_PATHS, ids=[p.stem for p in PROFILE_PATHS])
    def test_profile_loads_without_error(self, path: Path):
        profile = ProfileLoader.load_profile(path)
        assert isinstance(profile, DeviceProfile)

    @pytest.mark.parametrize("path", PROFILE_PATHS, ids=[p.stem for p in PROFILE_PATHS])
    def test_profile_has_required_fields(self, path: Path):
        profile = ProfileLoader.load_profile(path)
        assert profile.vendor, f"{path.stem}: vendor must not be empty"
        assert profile.model, f"{path.stem}: model must not be empty"
        assert profile.driver_type, f"{path.stem}: driver_type must not be empty"

    def test_load_all_returns_all_profiles(self):
        profiles = ProfileLoader.load_all(PROFILES_DIR)
        assert len(profiles) == len(PROFILE_PATHS)
        for stem, profile in profiles.items():
            assert isinstance(profile, DeviceProfile)


# ── Property: CapabilityManifest completeness ─────────────────────────────

class TestCapabilityManifest:

    @pytest.mark.parametrize("path", PROFILE_PATHS, ids=[p.stem for p in PROFILE_PATHS])
    def test_manifest_has_driver_type(self, path: Path):
        profile = ProfileLoader.load_profile(path)
        manifest = ProfileLoader.to_capability_manifest(profile)
        assert isinstance(manifest, CapabilityManifest)
        assert manifest.driver_type == profile.driver_type

    @pytest.mark.parametrize("path", PROFILE_PATHS, ids=[p.stem for p in PROFILE_PATHS])
    def test_manifest_has_vendor(self, path: Path):
        profile = ProfileLoader.load_profile(path)
        manifest = ProfileLoader.to_capability_manifest(profile)
        assert manifest.vendor == profile.vendor

    @pytest.mark.parametrize("path", PROFILE_PATHS, ids=[p.stem for p in PROFILE_PATHS])
    def test_manifest_has_data_capabilities(self, path: Path):
        profile = ProfileLoader.load_profile(path)
        manifest = ProfileLoader.to_capability_manifest(profile)
        assert isinstance(manifest.data_capabilities, list)
        assert len(manifest.data_capabilities) > 0, (
            f"{path.stem}: data_capabilities must not be empty"
        )

    @pytest.mark.parametrize("path", PROFILE_PATHS, ids=[p.stem for p in PROFILE_PATHS])
    def test_manifest_preserves_severity_mapping(self, path: Path):
        profile = ProfileLoader.load_profile(path)
        manifest = ProfileLoader.to_capability_manifest(profile)
        assert manifest.severity_mapping == profile.severity_mapping

    @pytest.mark.parametrize("path", PROFILE_PATHS, ids=[p.stem for p in PROFILE_PATHS])
    def test_manifest_preserves_script_language(self, path: Path):
        profile = ProfileLoader.load_profile(path)
        manifest = ProfileLoader.to_capability_manifest(profile)
        assert manifest.script_language == profile.script_language
