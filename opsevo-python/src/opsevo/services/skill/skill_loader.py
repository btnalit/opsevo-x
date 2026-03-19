"""
SkillLoader — 从文件系统加载技能定义

从 JSON/YAML 数据文件加载内置技能定义。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import structlog

logger = structlog.get_logger(__name__)

try:
    import yaml
    HAS_YAML = True
except ImportError:
    HAS_YAML = False


class SkillLoader:
    """从文件系统加载技能定义。"""

    def __init__(self, skills_dir: str = "data/ai-ops/skills") -> None:
        self._dir = Path(skills_dir)

    def load_all(self) -> dict[str, dict[str, Any]]:
        skills: dict[str, dict[str, Any]] = {}
        builtin_dir = self._dir / "builtin"
        if builtin_dir.exists():
            for f in builtin_dir.iterdir():
                if f.suffix in (".json", ".yaml", ".yml"):
                    try:
                        defn = self._load_file(f)
                        name = defn.get("name", f.stem)
                        skills[name] = defn
                    except Exception:
                        logger.warning("Failed to load skill", file=str(f))

        # load mapping
        mapping_file = self._dir / "mapping.json"
        if mapping_file.exists():
            try:
                with open(mapping_file) as fh:
                    mapping = json.load(fh)
                for name, meta in mapping.items():
                    if name not in skills:
                        skills[name] = meta
            except Exception:
                logger.warning("Failed to load skill mapping")

        logger.info("Skills loaded", count=len(skills))
        return skills

    @staticmethod
    def _load_file(path: Path) -> dict[str, Any]:
        text = path.read_text(encoding="utf-8")
        if path.suffix == ".json":
            return json.loads(text)
        if HAS_YAML and path.suffix in (".yaml", ".yml"):
            return yaml.safe_load(text)
        raise ValueError(f"Unsupported file type: {path.suffix}")
