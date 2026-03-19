"""SkillRegistry — 技能注册表，集中管理技能元数据。"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import structlog

logger = structlog.get_logger(__name__)


class SkillRegistry:
    """技能注册表。

    Parameters
    ----------
    data_dir:
        Directory where ``registry.json`` is persisted.
        When *None* the registry is purely in-memory (backward-compatible).
    """

    def __init__(self, data_dir: Path | str | None = None) -> None:
        self._registry: dict[str, dict[str, Any]] = {}
        self._data_dir = Path(data_dir) if data_dir is not None else None
        if self._data_dir is not None:
            self.load()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def register(self, name: str, metadata: dict[str, Any]) -> None:
        self._registry[name] = metadata
        self._auto_save()

    def get(self, name: str) -> dict[str, Any] | None:
        return self._registry.get(name)

    def list_names(self) -> list[str]:
        return list(self._registry.keys())

    def list_all(self) -> list[dict[str, Any]]:
        return [{"name": k, **v} for k, v in self._registry.items()]

    def remove(self, name: str) -> None:
        self._registry.pop(name, None)
        self._auto_save()

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------

    def save(self) -> None:
        """Serialize the registry to ``{data_dir}/registry.json``."""
        if self._data_dir is None:
            return
        try:
            self._data_dir.mkdir(parents=True, exist_ok=True)
            payload = {"skills": self._registry}
            self._data_dir.joinpath("registry.json").write_text(
                json.dumps(payload, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except Exception:
            logger.warning("skill_registry.save_failed", exc_info=True)

    def load(self) -> None:
        """Deserialize ``{data_dir}/registry.json`` into the registry."""
        if self._data_dir is None:
            return
        path = self._data_dir / "registry.json"
        if not path.is_file():
            return
        try:
            raw = path.read_text(encoding="utf-8")
            data = json.loads(raw)
            self._registry = data.get("skills", {})
        except (json.JSONDecodeError, ValueError):
            logger.error("skill_registry.load_corrupt_json", path=str(path))
        except Exception:
            logger.warning("skill_registry.load_failed", exc_info=True)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _auto_save(self) -> None:
        """Persist after mutations when a *data_dir* is configured."""
        if self._data_dir is not None:
            self.save()
