"""
KnowledgeDistiller — 从 Brain 运行经验中提炼知识

将 Brain 的情景记忆、行动结果、学习笔记提炼为
可复用的知识条目，存入知识库。
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

import structlog

logger = structlog.get_logger(__name__)


@dataclass
class DistilledKnowledge:
    id: str = ""
    title: str = ""
    content: str = ""
    category: str = "operational"
    source: str = "brain"
    confidence: float = 0.5
    created_at: float = field(default_factory=time.time)
    tags: list[str] = field(default_factory=list)


class KnowledgeDistiller:
    """从 Brain 经验中提炼可复用知识。"""

    def __init__(self, knowledge_base: Any = None, datastore: Any = None) -> None:
        self._knowledge_base = knowledge_base
        self._datastore = datastore
        self._buffer: list[dict[str, Any]] = []
        self._distilled_count = 0

    def add_experience(self, content: str, context: str, outcome: str, tags: list[str] | None = None) -> None:
        self._buffer.append({
            "content": content,
            "context": context,
            "outcome": outcome,
            "tags": tags or [],
            "timestamp": time.time(),
        })

    async def distill(self) -> list[DistilledKnowledge]:
        if not self._buffer:
            return []

        experiences = list(self._buffer)
        self._buffer.clear()

        distilled: list[DistilledKnowledge] = []
        for exp in experiences:
            knowledge = self._extract_knowledge(exp)
            if knowledge:
                distilled.append(knowledge)
                if self._knowledge_base:
                    try:
                        await self._knowledge_base.add_entry(
                            title=knowledge.title,
                            content=knowledge.content,
                            metadata={"source": "brain", "category": knowledge.category, "tags": knowledge.tags},
                        )
                    except Exception:
                        logger.warning("Failed to store distilled knowledge", title=knowledge.title)

        self._distilled_count += len(distilled)
        if distilled:
            logger.info("Knowledge distilled", count=len(distilled))
        return distilled

    def _extract_knowledge(self, exp: dict) -> DistilledKnowledge | None:
        content = exp.get("content", "")
        outcome = exp.get("outcome", "")
        if not content or len(content) < 20:
            return None

        title = content[:80].strip()
        body = f"Context: {exp.get('context', '')}\nAction: {content}\nOutcome: {outcome}"

        return DistilledKnowledge(
            title=title,
            content=body,
            tags=exp.get("tags", []),
            confidence=0.6 if "success" in outcome.lower() else 0.4,
        )

    @property
    def distilled_count(self) -> int:
        return self._distilled_count

    @property
    def buffer_size(self) -> int:
        return len(self._buffer)
