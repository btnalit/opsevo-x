"""Unit tests for SkillRegistry persistence (save/load)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from opsevo.services.skill.skill_registry import SkillRegistry


# ------------------------------------------------------------------
# Backward compatibility — pure in-memory mode
# ------------------------------------------------------------------


class TestInMemoryMode:
    """When data_dir is None, behaviour is identical to the original class."""

    def test_register_and_get(self) -> None:
        reg = SkillRegistry()
        reg.register("s1", {"description": "test"})
        assert reg.get("s1") == {"description": "test"}

    def test_remove(self) -> None:
        reg = SkillRegistry()
        reg.register("s1", {"description": "test"})
        reg.remove("s1")
        assert reg.get("s1") is None

    def test_list_names(self) -> None:
        reg = SkillRegistry()
        reg.register("a", {})
        reg.register("b", {})
        assert sorted(reg.list_names()) == ["a", "b"]

    def test_list_all(self) -> None:
        reg = SkillRegistry()
        reg.register("x", {"v": 1})
        items = reg.list_all()
        assert items == [{"name": "x", "v": 1}]


# ------------------------------------------------------------------
# Persistence — save / load
# ------------------------------------------------------------------


class TestPersistence:
    def test_save_creates_file(self, tmp_path: Path) -> None:
        reg = SkillRegistry(data_dir=tmp_path)
        reg.register("skill-a", {"definition": {"tools": []}})
        assert (tmp_path / "registry.json").is_file()

    def test_save_load_roundtrip(self, tmp_path: Path) -> None:
        reg = SkillRegistry(data_dir=tmp_path)
        meta = {
            "definition": {"tools": []},
            "created_by": "brain",
            "created_at": "2025-01-01T00:00:00Z",
        }
        reg.register("my-skill", meta)

        # Load into a fresh registry
        reg2 = SkillRegistry(data_dir=tmp_path)
        assert reg2.get("my-skill") == meta

    def test_load_missing_file_is_noop(self, tmp_path: Path) -> None:
        reg = SkillRegistry(data_dir=tmp_path)
        assert reg.list_names() == []

    def test_load_corrupt_json_logs_warning(self, tmp_path: Path) -> None:
        (tmp_path / "registry.json").write_text("NOT JSON", encoding="utf-8")
        reg = SkillRegistry(data_dir=tmp_path)
        # Should not crash; registry stays empty
        assert reg.list_names() == []

    def test_remove_persists(self, tmp_path: Path) -> None:
        reg = SkillRegistry(data_dir=tmp_path)
        reg.register("s1", {"v": 1})
        reg.register("s2", {"v": 2})
        reg.remove("s1")

        reg2 = SkillRegistry(data_dir=tmp_path)
        assert reg2.get("s1") is None
        assert reg2.get("s2") == {"v": 2}

    def test_save_creates_directory(self, tmp_path: Path) -> None:
        nested = tmp_path / "a" / "b" / "c"
        reg = SkillRegistry(data_dir=nested)
        reg.register("deep", {"ok": True})
        assert (nested / "registry.json").is_file()

    def test_persistence_format(self, tmp_path: Path) -> None:
        """Verify the on-disk JSON matches the design spec format."""
        reg = SkillRegistry(data_dir=tmp_path)
        reg.register("skill-name", {
            "definition": {"tools": []},
            "created_by": "brain",
            "created_at": "2025-01-01T00:00:00Z",
            "capsule_dir": "/app/data/ai-ops/skills/capsules/skill-name",
        })
        raw = json.loads((tmp_path / "registry.json").read_text(encoding="utf-8"))
        assert "skills" in raw
        assert "skill-name" in raw["skills"]
        assert raw["skills"]["skill-name"]["created_by"] == "brain"

    def test_no_persistence_when_data_dir_none(self, tmp_path: Path) -> None:
        """In-memory mode must not write any files."""
        reg = SkillRegistry()  # data_dir=None
        reg.register("x", {"v": 1})
        reg.remove("x")
        # tmp_path should remain empty (we didn't pass it)
        assert not list(tmp_path.iterdir())
