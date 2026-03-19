"""DeepSeek adapter (OpenAI-compatible API).

Requirements: 11.2
"""

from __future__ import annotations

from opsevo.services.ai.adapters.openai import OpenAIAdapter


class DeepSeekAdapter(OpenAIAdapter):
    def __init__(self, api_key: str, model: str = "deepseek-chat"):
        super().__init__(api_key, base_url="https://api.deepseek.com/v1", model=model)

    @property
    def provider_name(self) -> str:
        return "deepseek"

    def get_model_info(self):
        return {"provider": "deepseek", "model": self._model}
