"""
SkillLoader — 从文件系统加载技能定义

从 JSON/YAML 数据文件加载内置技能定义。
"""

from __future__ import annotations

import json
import shutil
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
        self._intent_mapping: dict[str, Any] = {}

    def load_all(self) -> dict[str, dict[str, Any]]:
        skills: dict[str, dict[str, Any]] = {}
        builtin_dir = self._dir / "builtin"
        if builtin_dir.exists():
            for entry in builtin_dir.iterdir():
                # Directory-based skill: <name>/config.json + SKILL.md
                if entry.is_dir():
                    try:
                        defn = self._load_skill_dir(entry)
                        if defn is not None:
                            defn["isBuiltin"] = True
                            name = defn.get("name", entry.name)
                            skills[name] = defn
                    except Exception:
                        logger.warning("Failed to load skill dir", dir=str(entry))
                # Legacy single-file skill
                elif entry.suffix in (".json", ".yaml", ".yml"):
                    try:
                        defn = self._load_file(entry)
                        defn["isBuiltin"] = True
                        name = defn.get("name", entry.stem)
                        skills[name] = defn
                    except Exception:
                        logger.warning("Failed to load skill", file=str(entry))

        # Load custom skills
        custom_dir = self._dir / "custom"
        if custom_dir.exists():
            for entry in custom_dir.iterdir():
                if entry.is_dir():
                    try:
                        defn = self._load_skill_dir(entry)
                        if defn is not None:
                            defn["isBuiltin"] = False
                            name = defn.get("name", entry.name)
                            skills[name] = defn
                    except Exception:
                        logger.warning("Failed to load custom skill dir", dir=str(entry))
                elif entry.suffix in (".json", ".yaml", ".yml"):
                    try:
                        defn = self._load_file(entry)
                        defn["isBuiltin"] = False
                        name = defn.get("name", entry.stem)
                        skills[name] = defn
                    except Exception:
                        logger.warning("Failed to load custom skill", file=str(entry))

        # load intent mapping (NOT skill definitions — used by intent routing only)
        mapping_file = self._dir / "mapping.json"
        if mapping_file.exists():
            try:
                with open(mapping_file, encoding="utf-8") as fh:
                    self._intent_mapping = json.load(fh)
            except Exception:
                logger.warning("Failed to load skill mapping")

        logger.info("Skills loaded", count=len(skills))
        return skills

    @staticmethod
    def _load_skill_dir(dir_path: Path) -> dict[str, Any] | None:
        """Load a directory-based skill (config.json + optional SKILL.md)."""
        config_file = dir_path / "config.json"
        if not config_file.exists():
            return None
        with open(config_file, encoding="utf-8") as fh:
            defn: dict[str, Any] = json.load(fh)

        skill_md = dir_path / "SKILL.md"
        if skill_md.exists():
            md_text = skill_md.read_text(encoding="utf-8")
            meta = SkillLoader._parse_frontmatter(md_text)
            # Merge frontmatter into definition (frontmatter wins for name/description/tags/triggers)
            for key in ("name", "description", "version", "author", "tags", "triggers", "suggestedSkills"):
                if key in meta:
                    defn[key] = meta[key]
            defn["system_prompt"] = md_text

        # Ensure name is set
        if "name" not in defn:
            defn["name"] = dir_path.name
        return defn

    @staticmethod
    def _parse_frontmatter(md_text: str) -> dict[str, Any]:
        """Parse YAML frontmatter from a markdown file (between --- delimiters)."""
        if not md_text.startswith("---"):
            return {}
        end = md_text.find("---", 3)
        if end == -1:
            return {}
        fm_text = md_text[3:end].strip()
        if not fm_text:
            return {}
        if HAS_YAML:
            try:
                return yaml.safe_load(fm_text) or {}
            except Exception:
                return {}
        # Minimal fallback: extract name and description
        result: dict[str, Any] = {}
        for line in fm_text.splitlines():
            if ":" in line:
                k, v = line.split(":", 1)
                k, v = k.strip(), v.strip()
                if k in ("name", "description", "version", "author"):
                    result[k] = v
        return result

    @staticmethod
    def _load_file(path: Path) -> dict[str, Any]:
        text = path.read_text(encoding="utf-8")
        if path.suffix == ".json":
            return json.loads(text)
        if HAS_YAML and path.suffix in (".yaml", ".yml"):
            return yaml.safe_load(text)
        raise ValueError(f"Unsupported file type: {path.suffix}")

    # ------------------------------------------------------------------
    # CRUD methods (used by skills API)
    # ------------------------------------------------------------------

    async def create_skill(
        self,
        name: str,
        description: str = "",
        content: str | None = None,
        config: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Create a new custom skill on disk and return its definition."""
        skill_dir = self._dir / "custom" / name
        skill_dir.mkdir(parents=True, exist_ok=True)

        cfg: dict[str, Any] = {
            "name": name,
            "description": description,
            **(config or {}),
        }
        (skill_dir / "config.json").write_text(json.dumps(cfg, indent=2, ensure_ascii=False), encoding="utf-8")

        md_content = content or f"---\nname: {name}\ndescription: {description}\n---\n"
        (skill_dir / "SKILL.md").write_text(md_content, encoding="utf-8")

        defn = self._load_skill_dir(skill_dir) or cfg
        defn["isBuiltin"] = False
        defn["path"] = str(skill_dir)
        defn["files"] = [f.name for f in skill_dir.iterdir() if f.is_file()]
        logger.info("Skill created", name=name)
        return defn

    async def update_skill(
        self,
        name: str,
        description: str | None = None,
        content: str | None = None,
        config: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Update an existing custom skill."""
        skill_dir = self._dir / "custom" / name
        if not skill_dir.exists():
            raise FileNotFoundError(f"Skill directory not found: {name}")

        cfg_path = skill_dir / "config.json"
        if cfg_path.exists():
            existing = json.loads(cfg_path.read_text(encoding="utf-8"))
        else:
            existing = {"name": name}

        if description is not None:
            existing["description"] = description
        if config is not None:
            existing.update(config)
        cfg_path.write_text(json.dumps(existing, indent=2, ensure_ascii=False), encoding="utf-8")

        if content is not None:
            (skill_dir / "SKILL.md").write_text(content, encoding="utf-8")

        defn = self._load_skill_dir(skill_dir) or existing
        defn["isBuiltin"] = False
        defn["path"] = str(skill_dir)
        defn["files"] = [f.name for f in skill_dir.iterdir() if f.is_file()]
        logger.info("Skill updated", name=name)
        return defn

    async def delete_skill(self, name: str) -> None:
        """Delete a custom skill from disk."""
        skill_dir = self._dir / "custom" / name
        if skill_dir.exists():
            shutil.rmtree(skill_dir)
            logger.info("Skill deleted", name=name)

    async def clone_skill(self, source_name: str, new_name: str) -> dict[str, Any]:
        """Clone a skill (builtin or custom) into a new custom skill."""
        # Try custom first, then builtin
        source_dir = self._dir / "custom" / source_name
        if not source_dir.exists():
            source_dir = self._dir / "builtin" / source_name
        if not source_dir.exists():
            raise FileNotFoundError(f"Source skill not found: {source_name}")

        dest_dir = self._dir / "custom" / new_name
        shutil.copytree(source_dir, dest_dir)

        # Update name in config.json
        cfg_path = dest_dir / "config.json"
        if cfg_path.exists():
            cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
            cfg["name"] = new_name
            cfg_path.write_text(json.dumps(cfg, indent=2, ensure_ascii=False), encoding="utf-8")

        defn = self._load_skill_dir(dest_dir) or {"name": new_name}
        defn["isBuiltin"] = False
        defn["path"] = str(dest_dir)
        defn["files"] = [f.name for f in dest_dir.iterdir() if f.is_file()]
        logger.info("Skill cloned", source=source_name, target=new_name)
        return defn

    async def read_skill_file(self, name: str, filename: str) -> str:
        """Read a file from a skill directory."""
        for sub in ("custom", "builtin"):
            fp = self._dir / sub / name / filename
            if fp.exists():
                return fp.read_text(encoding="utf-8")
        raise FileNotFoundError(f"File not found: {name}/{filename}")

    async def write_skill_file(self, name: str, filename: str, content: str) -> None:
        """Write a file in a custom skill directory."""
        fp = self._dir / "custom" / name / filename
        if not fp.parent.exists():
            raise FileNotFoundError(f"Skill directory not found: {name}")
        fp.write_text(content, encoding="utf-8")
        logger.info("Skill file written", name=name, filename=filename)

    async def reload_skill(self, name: str) -> dict[str, Any] | None:
        """Reload a skill definition from disk."""
        for sub in ("custom", "builtin"):
            skill_dir = self._dir / sub / name
            if skill_dir.exists():
                defn = self._load_skill_dir(skill_dir)
                if defn:
                    defn["isBuiltin"] = sub == "builtin"
                    defn["path"] = str(skill_dir)
                    defn["files"] = [f.name for f in skill_dir.iterdir() if f.is_file()]
                return defn
        return None
