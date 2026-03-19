"""PromptKnowledgeSeeder — injects knowledge-base context into prompts.

Requirements: 11.5
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class PromptKnowledgeSeeder:
    def __init__(self, knowledge_path: str = "data/ai-ops/knowledge-seed"):
        self._path = Path(knowledge_path)
        self._api_paths: dict = {}
        self._prompt_knowledge: dict = {}

    def load(self) -> None:
        api_file = self._path / "api-paths.json"
        if api_file.exists():
            self._api_paths = json.loads(api_file.read_text(encoding="utf-8"))
        pk_file = self._path / "prompt-knowledge.json"
        if pk_file.exists():
            self._prompt_knowledge = json.loads(pk_file.read_text(encoding="utf-8"))
        logger.info("knowledge_seeder_loaded", api_paths=len(self._api_paths), knowledge=len(self._prompt_knowledge))

    def get_api_paths(self) -> dict:
        return self._api_paths

    def get_prompt_knowledge(self) -> dict:
        return self._prompt_knowledge

    def seed_context(self, context: dict[str, Any]) -> dict[str, Any]:
        context["api_paths"] = self._api_paths
        context["prompt_knowledge"] = self._prompt_knowledge
        return context
