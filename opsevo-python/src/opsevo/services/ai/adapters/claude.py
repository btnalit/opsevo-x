"""Anthropic Claude adapter.

Requirements: 11.2
"""

from __future__ import annotations

import json
from typing import Any, AsyncIterator

import httpx

from opsevo.services.ai.adapters.base import AIAdapter
from opsevo.utils.logger import get_logger

logger = get_logger(__name__)

_BASE = "https://api.anthropic.com/v1"


class ClaudeAdapter(AIAdapter):
    def __init__(self, api_key: str, model: str = "claude-3-5-sonnet-20241022"):
        self._api_key = api_key
        self._model = model
        self._client: httpx.AsyncClient | None = None

    @property
    def provider_name(self) -> str:
        return "claude"

    def _ensure_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                base_url=_BASE,
                headers={
                    "x-api-key": self._api_key,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                timeout=120.0,
            )
        return self._client

    @staticmethod
    def _to_claude_messages(messages: list[dict]) -> tuple[str, list[dict]]:
        system = ""
        converted = []
        for m in messages:
            if m.get("role") == "system":
                system = m.get("content", "")
            else:
                converted.append({"role": m.get("role", "user"), "content": m.get("content", "")})
        return system, converted

    async def chat(self, messages, *, model="", temperature=0.7, max_tokens=4096, tools=None, **kwargs):
        client = self._ensure_client()
        system, msgs = self._to_claude_messages(messages)
        body: dict[str, Any] = {
            "model": model or self._model,
            "messages": msgs,
            "max_tokens": max_tokens,
            "temperature": temperature,
        }
        if system:
            body["system"] = system
        resp = await client.post("/messages", json=body)
        resp.raise_for_status()
        data = resp.json()
        text = ""
        for block in data.get("content", []):
            if block.get("type") == "text":
                text += block.get("text", "")
        return {"choices": [{"message": {"role": "assistant", "content": text}}], "model": data.get("model", "")}

    async def chat_stream(self, messages, *, model="", temperature=0.7, max_tokens=4096, tools=None, **kwargs):
        client = self._ensure_client()
        system, msgs = self._to_claude_messages(messages)
        body: dict[str, Any] = {
            "model": model or self._model,
            "messages": msgs,
            "max_tokens": max_tokens,
            "temperature": temperature,
            "stream": True,
        }
        if system:
            body["system"] = system
        async with client.stream("POST", "/messages", json=body) as resp:
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                if line.startswith("data: "):
                    try:
                        chunk = json.loads(line[6:])
                        if chunk.get("type") == "content_block_delta":
                            delta = chunk.get("delta", {})
                            if delta.get("type") == "text_delta":
                                yield {"choices": [{"delta": {"content": delta.get("text", "")}}]}
                    except json.JSONDecodeError:
                        continue

    def get_model_info(self):
        return {"provider": "claude", "model": self._model}

    async def close(self):
        if self._client and not self._client.is_closed:
            await self._client.aclose()
            self._client = None
