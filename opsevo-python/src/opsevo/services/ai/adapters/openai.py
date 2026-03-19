"""OpenAI-compatible adapter (also works for proxies).

Requirements: 11.2
"""

from __future__ import annotations

import json
from typing import Any, AsyncIterator

import httpx

from opsevo.services.ai.adapters.base import AIAdapter
from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class OpenAIAdapter(AIAdapter):
    def __init__(self, api_key: str, base_url: str = "https://api.openai.com/v1", model: str = "gpt-4o"):
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._model = model
        self._client: httpx.AsyncClient | None = None

    @property
    def provider_name(self) -> str:
        return "openai"

    def _ensure_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                base_url=self._base_url,
                headers={"Authorization": f"Bearer {self._api_key}"},
                timeout=120.0,
            )
        return self._client

    async def chat(self, messages, *, model="", temperature=0.7, max_tokens=4096, tools=None, **kwargs):
        client = self._ensure_client()
        body: dict[str, Any] = {
            "model": model or self._model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        if tools:
            body["tools"] = tools
        resp = await client.post("/chat/completions", json=body)
        resp.raise_for_status()
        return resp.json()

    async def chat_stream(self, messages, *, model="", temperature=0.7, max_tokens=4096, tools=None, **kwargs):
        client = self._ensure_client()
        body: dict[str, Any] = {
            "model": model or self._model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": True,
        }
        if tools:
            body["tools"] = tools
        async with client.stream("POST", "/chat/completions", json=body) as resp:
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                if line.startswith("data: "):
                    data = line[6:]
                    if data.strip() == "[DONE]":
                        return
                    try:
                        yield json.loads(data)
                    except json.JSONDecodeError:
                        continue

    def get_model_info(self):
        return {"provider": "openai", "model": self._model, "base_url": self._base_url}

    async def close(self):
        if self._client and not self._client.is_closed:
            await self._client.aclose()
            self._client = None
