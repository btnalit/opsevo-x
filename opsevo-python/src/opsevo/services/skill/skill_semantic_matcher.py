"""SkillSemanticMatcher — 基于语义相似度的技能匹配。"""

from __future__ import annotations
from typing import Any
import structlog

logger = structlog.get_logger(__name__)


class SkillSemanticMatcher:
    """使用 embedding 进行语义匹配。"""

    def __init__(self, skill_manager: Any = None, embedding_service: Any = None) -> None:
        self._manager = skill_manager
        self._embedding = embedding_service
        self._skill_embeddings: dict[str, list[float]] = {}

    async def build_index(self) -> None:
        if not self._manager or not self._embedding:
            return
        for name in self._manager.list_enabled():
            defn = self._manager.get(name)
            if defn:
                desc = defn.get("description", name)
                try:
                    emb = await self._embedding.embed(desc)
                    self._skill_embeddings[name] = emb
                except Exception:
                    pass
        logger.info("Skill semantic index built", count=len(self._skill_embeddings))

    async def match(self, query: str, threshold: float = 0.5) -> str | None:
        if not self._embedding or not self._skill_embeddings:
            return None
        try:
            query_emb = await self._embedding.embed(query)
            best_name = None
            best_score = 0.0
            for name, emb in self._skill_embeddings.items():
                score = self._cosine_similarity(query_emb, emb)
                if score > best_score:
                    best_score = score
                    best_name = name
            return best_name if best_score >= threshold else None
        except Exception:
            return None

    @staticmethod
    def _cosine_similarity(a: list[float], b: list[float]) -> float:
        if len(a) != len(b) or not a:
            return 0.0
        dot = sum(x * y for x, y in zip(a, b))
        norm_a = sum(x * x for x in a) ** 0.5
        norm_b = sum(x * x for x in b) ** 0.5
        if norm_a == 0 or norm_b == 0:
            return 0.0
        return dot / (norm_a * norm_b)
