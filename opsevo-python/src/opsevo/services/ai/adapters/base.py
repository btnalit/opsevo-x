"""AI adapter abstract base class.

Requirements: 11.2
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, AsyncIterator


class AIAdapter(ABC):
    """Base class for all AI provider adapters."""

    @property
    @abstractmethod
    def provider_name(self) -> str: ...

    @abstractmethod
    async def chat(
        self,
        messages: list[dict[str, str]],
        *,
        model: str = "",
        temperature: float = 0.7,
        max_tokens: int = 4096,
        tools: list[dict] | None = None,
        **kwargs: Any,
    ) -> dict[str, Any]:
        """Send a chat completion request and return the full response."""
        ...

    @abstractmethod
    async def chat_stream(
        self,
        messages: list[dict[str, str]],
        *,
        model: str = "",
        temperature: float = 0.7,
        max_tokens: int = 4096,
        tools: list[dict] | None = None,
        **kwargs: Any,
    ) -> AsyncIterator[dict[str, Any]]:
        """Stream chat completion chunks."""
        ...

    @abstractmethod
    def get_model_info(self) -> dict[str, Any]:
        """Return metadata about the configured model."""
        ...

    async def close(self) -> None:
        """Release resources (override if needed)."""
