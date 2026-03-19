"""IntelligentRetriever — orchestrates query rewriting, expansion, and hybrid search.

Requirements: 10.1, 10.6
"""

from __future__ import annotations

from typing import Any

from opsevo.services.rag.credibility_calculator import CredibilityCalculator
from opsevo.services.rag.hybrid_search import HybridSearchEngine
from opsevo.services.rag.query_rewriter import QueryRewriter
from opsevo.services.rag.synonym_expander import SynonymExpander
from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class IntelligentRetriever:
    def __init__(self, search_engine: HybridSearchEngine):
        self._engine = search_engine
        self._rewriter = QueryRewriter()
        self._expander = SynonymExpander()
        self._credibility = CredibilityCalculator()

    async def retrieve(self, query: str, top_k: int = 5, threshold: float = 0.3) -> list[dict[str, Any]]:
        rewritten = self._rewriter.rewrite(query)
        expanded = self._expander.expand(rewritten)
        results = await self._engine.search(expanded, top_k=top_k * 2, threshold=threshold)
        for r in results:
            r["credibility"] = self._credibility.calculate(r)
        results.sort(key=lambda x: x.get("credibility", 0), reverse=True)
        return results[:top_k]
