"""PromptTemplateService — CRUD for prompt templates.

Requirements: 11.5
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any

from opsevo.data.datastore import DataStore
from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class PromptTemplateService:
    def __init__(self, datastore: DataStore, templates_path: str = "data/prompt-templates.json"):
        self._ds = datastore
        self._templates_path = Path(templates_path)
        self._cache: list[dict] = []

    async def initialize(self) -> None:
        if self._templates_path.exists():
            self._cache = json.loads(self._templates_path.read_text(encoding="utf-8"))
            logger.info("prompt_templates_loaded", count=len(self._cache))

    async def list_templates(self, device_id: str = "") -> list[dict]:
        rows = await self._ds.query(
            "SELECT * FROM prompt_templates WHERE device_id = $1 OR device_id IS NULL ORDER BY created_at DESC",
            (device_id,),
        )
        return rows if rows else self._cache

    async def get_template(self, template_id: str) -> dict | None:
        return await self._ds.query_one("SELECT * FROM prompt_templates WHERE id = $1", (template_id,))

    async def create_template(self, data: dict) -> dict:
        tid = str(uuid.uuid4())
        await self._ds.execute(
            "INSERT INTO prompt_templates (id, name, content, description, device_id) VALUES ($1, $2, $3, $4, $5)",
            (tid, data["name"], data["content"], data.get("description", ""), data.get("device_id")),
        )
        return {"id": tid, **data}

    async def update_template(self, template_id: str, data: dict) -> dict | None:
        existing = await self.get_template(template_id)
        if not existing:
            return None
        sets, params, idx = [], [], 1
        for k, v in data.items():
            if v is not None:
                sets.append(f"{k} = ${idx}")
                params.append(v)
                idx += 1
        if sets:
            params.append(template_id)
            await self._ds.execute(
                f"UPDATE prompt_templates SET {', '.join(sets)} WHERE id = ${idx}", tuple(params)
            )
        return await self.get_template(template_id)

    async def delete_template(self, template_id: str) -> bool:
        return (await self._ds.execute("DELETE FROM prompt_templates WHERE id = $1", (template_id,))) > 0
