"""Zhipu GLM adapter (OpenAI-compatible API).

Requirements: 11.2
"""

from __future__ import annotations

from opsevo.services.ai.adapters.openai import OpenAIAdapter


class ZhipuAdapter(OpenAIAdapter):
    def __init__(self, api_key: str, model: str = "glm-4"):
        super().__init__(api_key, base_url="https://open.bigmodel.cn/api/paas/v4", model=model)

    @property
    def provider_name(self) -> str:
        return "zhipu"

    def get_model_info(self):
        return {"provider": "zhipu", "model": self._model}
