"""PromptComposer — assembles system prompt from modular sections.

Requirements: 11.5, 11.6
"""

from __future__ import annotations

from typing import Any, Protocol

from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class PromptModule(Protocol):
    """Each module contributes a named section to the system prompt."""
    name: str
    def render(self, context: dict[str, Any]) -> str: ...


class PromptComposer:
    """Composes a system prompt from registered modules."""

    def __init__(self) -> None:
        self._modules: list[PromptModule] = []

    def register(self, module: PromptModule) -> None:
        self._modules.append(module)

    def compose(self, context: dict[str, Any] | None = None) -> str:
        ctx = context or {}
        sections: list[str] = []
        for mod in self._modules:
            try:
                section = mod.render(ctx)
                if section:
                    sections.append(section)
            except Exception:
                logger.error("prompt_module_failed", module=mod.name, exc_info=True)
        return "\n\n".join(sections)
