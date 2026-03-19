"""Adapter factory — creates AI adapters by provider name.

Requirements: 11.2
"""

from __future__ import annotations

from opsevo.services.ai.adapters.base import AIAdapter
from opsevo.settings import Settings


def create_adapter(provider: str, settings: Settings, *, model: str = "", api_key: str = "", base_url: str = "") -> AIAdapter:
    """Instantiate the correct adapter for *provider*."""
    p = provider.lower()

    if p == "openai":
        from opsevo.services.ai.adapters.openai import OpenAIAdapter
        return OpenAIAdapter(
            api_key=api_key or settings.openai_api_key,
            base_url=base_url or settings.openai_base_url,
            model=model or settings.ai_model_name,
        )
    if p == "gemini":
        from opsevo.services.ai.adapters.gemini import GeminiAdapter
        return GeminiAdapter(
            api_key=api_key or settings.gemini_api_key,
            model=model or settings.ai_model_name,
        )
    if p == "claude":
        from opsevo.services.ai.adapters.claude import ClaudeAdapter
        return ClaudeAdapter(
            api_key=api_key or settings.claude_api_key,
            model=model or settings.ai_model_name,
        )
    if p == "deepseek":
        from opsevo.services.ai.adapters.deepseek import DeepSeekAdapter
        return DeepSeekAdapter(
            api_key=api_key or settings.deepseek_api_key,
            model=model or settings.ai_model_name,
        )
    if p == "qwen":
        from opsevo.services.ai.adapters.qwen import QwenAdapter
        return QwenAdapter(
            api_key=api_key or settings.qwen_api_key,
            model=model or settings.ai_model_name,
        )
    if p == "zhipu":
        from opsevo.services.ai.adapters.zhipu import ZhipuAdapter
        return ZhipuAdapter(
            api_key=api_key or settings.zhipu_api_key,
            model=model or settings.ai_model_name,
        )
    if p == "custom":
        from opsevo.services.ai.adapters.custom import CustomAdapter
        if not base_url:
            raise ValueError("Custom provider requires base_url")
        return CustomAdapter(
            api_key=api_key,
            base_url=base_url,
            model=model or "custom-model",
        )

    raise ValueError(f"Unknown AI provider: {provider}")
