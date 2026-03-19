"""
StateExecutor — 状态处理器执行包装

为状态处理器提供超时、重试、错误处理等通用能力。
"""

from __future__ import annotations

import asyncio
from typing import Any, Awaitable, Callable

import structlog

from .engine import TransitionResult

logger = structlog.get_logger(__name__)


class StateExecutor:
    """包装状态处理器，提供超时和错误处理。"""

    def __init__(self, default_timeout_s: float = 60.0, max_retries: int = 0) -> None:
        self._default_timeout = default_timeout_s
        self._max_retries = max_retries

    async def execute(
        self,
        handler: Callable[..., Awaitable[TransitionResult]],
        context: dict[str, Any],
        timeout_s: float | None = None,
    ) -> TransitionResult:
        timeout = timeout_s or self._default_timeout
        retries = 0

        while True:
            try:
                result = await asyncio.wait_for(handler(context), timeout=timeout)
                return result
            except asyncio.TimeoutError:
                logger.warning("State handler timed out", timeout=timeout)
                return TransitionResult.FAILURE
            except Exception as exc:
                retries += 1
                if retries > self._max_retries:
                    logger.exception("State handler failed after retries", retries=retries)
                    return TransitionResult.FAILURE
                logger.warning("State handler failed, retrying", retry=retries, error=str(exc))
                await asyncio.sleep(0.5 * retries)
