"""Alibaba Qwen adapter (OpenAI-compatible API).

Requirements: 11.2
"""

from __future__ import annotations

from opsevo.services.ai.adapters.openai import OpenAIAdapter


class QwenAdapter(OpenAIAdapter):
    def __init__(self, api_key: str, model: str = "qwen-turbo"):
        super().__init__(api_key, base_url="https://dashscope.aliyuncs.com/compatible-mode/v1", model=model)

    @property
    def provider_name(self) -> str:
        return "qwen"

    def get_model_info(self):
        return {"provider": "qwen", "model": self._model}
