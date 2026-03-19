"""
BatchProcessor 批处理服务
积攒告警进行批量 AI 分析，优化 API 调用。

- 在窗口期内积攒告警进行批量分析
- 窗口过期时将所有积攒的告警发送给 AI 分析
- AI 返回分析结果后分发给对应的告警事件
- 批次大小超过 max_batch_size 时分割成多个批次
"""

from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass, field
from typing import Any, Callable, Awaitable

import structlog

logger = structlog.get_logger(__name__)


@dataclass
class BatchConfig:
    window_seconds: float = 5.0
    max_batch_size: int = 20


@dataclass
class _BatchItem:
    alert: dict[str, Any]
    future: asyncio.Future[str] = field(default=None)  # type: ignore[assignment]


class BatchProcessor:
    """批处理服务：积攒告警后批量调用 AI 分析。"""

    def __init__(
        self,
        ai_analyzer: Any | None = None,
        config: BatchConfig | None = None,
    ) -> None:
        self._config = config or BatchConfig()
        self._ai_analyzer = ai_analyzer
        self._batch: list[_BatchItem] = []
        self._timer_task: asyncio.Task[None] | None = None
        self._processing = False
        self._running = False
        logger.info("BatchProcessor initialized", config=self._config)

    # ------------------------------------------------------------------
    async def add(self, alert: dict[str, Any]) -> str:
        loop = asyncio.get_running_loop()
        item = _BatchItem(alert=alert, future=loop.create_future())
        self._batch.append(item)

        if len(self._batch) >= self._config.max_batch_size:
            await self._process_batch()
        elif self._running and self._timer_task is None:
            self._start_timer()

        return await item.future

    async def flush(self) -> None:
        if self._batch:
            await self._process_batch()

    @property
    def pending_count(self) -> int:
        return len(self._batch)

    def start(self) -> None:
        if self._running:
            return
        self._running = True
        logger.info("BatchProcessor started")

    def stop(self) -> None:
        self._running = False
        self._cancel_timer()
        logger.info("BatchProcessor stopped")

    # ------------------------------------------------------------------
    # internals
    # ------------------------------------------------------------------
    def _start_timer(self) -> None:
        if self._timer_task is not None:
            return

        async def _tick() -> None:
            await asyncio.sleep(self._config.window_seconds)
            self._timer_task = None
            if self._batch:
                await self._process_batch()

        self._timer_task = asyncio.create_task(_tick())

    def _cancel_timer(self) -> None:
        if self._timer_task is not None:
            self._timer_task.cancel()
            self._timer_task = None

    async def _process_batch(self) -> None:
        if self._processing or not self._batch:
            return
        self._processing = True
        self._cancel_timer()

        current = list(self._batch)
        self._batch.clear()

        try:
            for chunk in self._split(current):
                await self._process_single(chunk)
        except Exception as exc:
            for item in current:
                if not item.future.done():
                    item.future.set_exception(exc)
        finally:
            self._processing = False
            if self._running and self._batch:
                self._start_timer()

    def _split(self, items: list[_BatchItem]) -> list[list[_BatchItem]]:
        sz = self._config.max_batch_size
        return [items[i : i + sz] for i in range(0, len(items), sz)]

    async def _process_single(self, batch: list[_BatchItem]) -> None:
        infos = [
            {
                "index": i,
                "id": it.alert.get("id", ""),
                "ruleName": it.alert.get("ruleName", ""),
                "severity": it.alert.get("severity", ""),
                "metric": it.alert.get("metric", ""),
                "currentValue": it.alert.get("currentValue", 0),
                "threshold": it.alert.get("threshold", 0),
                "message": it.alert.get("message", ""),
            }
            for i, it in enumerate(batch)
        ]

        try:
            analyses = await self._analyze_batch(infos)
            for i, item in enumerate(batch):
                result = analyses[i] if i < len(analyses) else self._default(item.alert)
                if not item.future.done():
                    item.future.set_result(result)
        except Exception as exc:
            for item in batch:
                if not item.future.done():
                    item.future.set_exception(exc)

    async def _analyze_batch(self, infos: list[dict]) -> list[str]:
        prompt = self._build_prompt(infos)
        if self._ai_analyzer is None:
            return [self._default_info(i) for i in infos]
        try:
            result = await self._ai_analyzer.analyze(
                {"type": "alert", "context": {"batchMode": True, "alerts": infos, "prompt": prompt}}
            )
            return self._parse_result(result.get("summary", ""), len(infos))
        except Exception:
            logger.warning("AI batch analysis failed, using fallback")
            return [self._default_info(i) for i in infos]

    @staticmethod
    def _build_prompt(infos: list[dict]) -> str:
        lines = [
            f"[告警 {i+1}] {a['ruleName']} ({a['severity']}): {a['message']} - 当前值: {a['currentValue']}, 阈值: {a['threshold']}"
            for i, a in enumerate(infos)
        ]
        return (
            f"请分析以下 {len(infos)} 个告警事件，为每个告警提供简要分析和建议。\n\n"
            + "\n".join(lines)
            + '\n\n请按照以下 JSON 格式返回分析结果：\n{"analyses": [{"index": 0, "analysis": "..."}]}'
        )

    @staticmethod
    def _parse_result(text: str, expected: int) -> list[str]:
        analyses: list[str | None] = [None] * expected
        try:
            m = re.search(r'\{[\s\S]*"analyses"[\s\S]*\}', text)
            if m:
                parsed = json.loads(m.group(0))
                for item in parsed.get("analyses", []):
                    idx = item.get("index", -1)
                    if 0 <= idx < expected:
                        analyses[idx] = item.get("analysis", "分析结果不可用")
        except (json.JSONDecodeError, KeyError):
            pass
        return [a if a is not None else "分析结果不可用" for a in analyses]

    @staticmethod
    def _default(alert: dict) -> str:
        return f"[{alert.get('severity','')}] {alert.get('ruleName','')}: {alert.get('message','')}。建议检查相关配置和系统状态。"

    @staticmethod
    def _default_info(info: dict) -> str:
        return f"[{info.get('severity','')}] {info.get('ruleName','')}: {info.get('message','')}。建议检查相关配置和系统状态。"
