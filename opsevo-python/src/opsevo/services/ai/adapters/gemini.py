"""Google Gemini adapter.

Requirements: 11.2
"""

from __future__ import annotations

import json
from typing import Any, AsyncIterator

import httpx

from opsevo.services.ai.adapters.base import AIAdapter
from opsevo.utils.logger import get_logger

logger = get_logger(__name__)

_BASE = "https://generativelanguage.googleapis.com/v1beta"


class GeminiAdapter(AIAdapter):
    def __init__(self, api_key: str, model: str = "gemini-1.5-flash"):
        self._api_key = api_key
        self._model = model
        self._client: httpx.AsyncClient | None = None

    @property
    def provider_name(self) -> str:
        return "gemini"

    def _ensure_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(timeout=120.0)
        return self._client

    def _build_url(self, stream: bool = False) -> str:
        action = "streamGenerateContent" if stream else "generateContent"
        return f"{_BASE}/models/{self._model}:{action}?key={self._api_key}"

    @staticmethod
    def _to_gemini_messages(messages: list[dict]) -> list[dict]:
        parts = []
        for m in messages:
            role = "model" if m.get("role") == "assistant" else "user"
            parts.append({"role": role, "parts": [{"text": m.get("content", "")}]})
        return parts

    async def chat(self, messages, *, model="", temperature=0.7, max_tokens=4096, tools=None, **kwargs):
        client = self._ensure_client()
        body: dict[str, Any] = {
            "contents": self._to_gemini_messages(messages),
            "generationConfig": {
                "temperature": temperature,
                "maxOutputTokens": max_tokens,
            },
        }
        resp = await client.post(self._build_url(), json=body)
        resp.raise_for_status()
        data = resp.json()
        # Normalize to OpenAI-like shape
        text = ""
        candidates = data.get("candidates", [])
        if candidates:
            parts = candidates[0].get("content", {}).get("parts", [])
            text = "".join(p.get("text", "") for p in parts)
        return {
            "choices": [{"message": {"role": "assistant", "content": text}}],
            "model": model or self._model,
        }

    async def chat_stream(self, messages, *, model="", temperature=0.7, max_tokens=4096, tools=None, **kwargs):
        client = self._ensure_client()
        body: dict[str, Any] = {
            "contents": self._to_gemini_messages(messages),
            "generationConfig": {
                "temperature": temperature,
                "maxOutputTokens": max_tokens,
            },
        }
        url = self._build_url(stream=True) + "&alt=sse"
        async with client.stream("POST", url, json=body) as resp:
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                if line.startswith("data: "):
                    try:
                        chunk = json.loads(line[6:])
                        candidates = chunk.get("candidates", [])
                        if candidates:
                            parts = candidates[0].get("content", {}).get("parts", [])
                            text = "".join(p.get("text", "") for p in parts)
                            yield {"choices": [{"delta": {"content": text}}]}
                    except json.JSONDecodeError:
                        continue

    def get_model_info(self):
        return {"provider": "gemini", "model": self._model}

    async def close(self):
        if self._client and not self._client.is_closed:
            await self._client.aclose()
            self._client = None
