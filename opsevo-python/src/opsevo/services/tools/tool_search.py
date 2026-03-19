"""
ToolSearchMeta — 元工具模式：工具搜索与渐进式暴露

当注册工具数量超过可配置阈值时，仅向 LLM 暴露核心工具 + search_tools 元工具，
LLM 通过 search_tools 按需搜索发现其他工具。

Requirements: 4.1, 4.2, 4.3, 4.4, 4.6, 4.7, 4.8
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

_DEFAULT_CORE_TOOLS = [
    "query_device",
    "execute_command",
    "search_knowledge",
    "analyze_alert",
    "send_notification",
]

SEARCH_TOOLS_DEFINITION: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "search_tools",
        "description": (
            "Search for available tools by keyword or description. "
            "Use this when you need a tool that isn't in your current list."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Search query to find matching tools",
                },
                "top_k": {
                    "type": "number",
                    "description": "Max results to return (default 5)",
                },
            },
            "required": ["query"],
        },
    },
}


class ToolSearchMeta:
    """元工具模式：根据工具数量决定暴露策略，支持关键词搜索。

    - should_use_search(): 工具数量是否超过阈值
    - get_exposed_tools(): 返回核心工具 + search_tools 元工具定义
    - search(): 语义搜索匹配工具，回退到关键词匹配
    """

    def __init__(
        self,
        tool_registry: Any,
        threshold: int = 15,
        core_tools: list[str] | None = None,
        embedding_service: Any = None,
    ) -> None:
        self._registry = tool_registry
        self._threshold = threshold
        self._core_tools = core_tools if core_tools is not None else list(_DEFAULT_CORE_TOOLS)
        self._embedding_service = embedding_service

    # ------------------------------------------------------------------
    # Properties for runtime configurability (Req 4.6)
    # ------------------------------------------------------------------

    @property
    def threshold(self) -> int:
        return self._threshold

    @threshold.setter
    def threshold(self, value: int) -> None:
        self._threshold = value

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def should_use_search(self, tools: list[dict[str, Any]] | None = None) -> bool:
        """Return True when total tool count exceeds the threshold.

        Parameters
        ----------
        tools:
            Pre-merged tool list.  When *None* falls back to registry.

        Requirements: 4.1, 4.4
        """
        if tools is None:
            tools = self._registry.get_all_tool_definitions()
        return len(tools) > self._threshold

    def get_exposed_tools(self, tools: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
        """Return tools to expose to the LLM.

        Below threshold  → all tools.
        Above threshold  → core tools + search_tools meta-tool.

        Parameters
        ----------
        tools:
            Pre-merged tool list (e.g. brain_tools + registry).
            When *None* falls back to registry only (backward compat).

        Requirements: 4.1, 4.4, 4.7
        """
        if tools is None:
            tools = self._registry.get_all_tool_definitions()

        if len(tools) <= self._threshold:
            return tools

        # Filter to core tools only
        core = [t for t in tools if t.get("function", {}).get("name") in self._core_tools]

        # Append the search_tools meta-tool definition
        core.append(SEARCH_TOOLS_DEFINITION)
        return core

    async def search(self, query: str, top_k: int = 5) -> list[dict[str, Any]]:
        """Search tools by query, returning complete tool definitions.

        Tries semantic search first (if embedding_service available),
        falls back to keyword matching.

        Requirements: 4.2, 4.3, 4.8
        """
        all_tools = self._registry.get_all_tool_definitions()
        if not all_tools:
            return []

        # Attempt semantic search (future — placeholder)
        if self._embedding_service is not None:
            logger.info("Embedding service available, but semantic search not yet implemented; falling back to keyword matching")

        return self._keyword_search(all_tools, query, top_k)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _keyword_search(
        tools: list[dict[str, Any]], query: str, top_k: int
    ) -> list[dict[str, Any]]:
        """Score each tool by how many query words appear in name + description."""
        words = query.lower().split()
        if not words:
            return []

        scored: list[tuple[int, dict[str, Any]]] = []
        for tool in tools:
            func = tool.get("function", {})
            name = func.get("name", "").lower()
            desc = func.get("description", "").lower()
            text = f"{name} {desc}"
            score = sum(1 for w in words if w in text)
            if score > 0:
                scored.append((score, tool))

        scored.sort(key=lambda x: x[0], reverse=True)
        return [t for _, t in scored[:top_k]]
