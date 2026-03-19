"""Custom provider adapter (user-configured OpenAI-compatible endpoint).

Requirements: 11.2
"""

from __future__ import annotations

from opsevo.services.ai.adapters.openai import OpenAIAdapter


class CustomAdapter(OpenAIAdapter):
    def __init__(self, api_key: str, base_url: str, model: str = "custom-model"):
        super().__init__(api_key, base_url=base_url, model=model)

    @property
    def provider_name(self) -> str:
        return "custom"

    def get_model_info(self):
        return {"provider": "custom", "model": self._model, "base_url": self._base_url}
