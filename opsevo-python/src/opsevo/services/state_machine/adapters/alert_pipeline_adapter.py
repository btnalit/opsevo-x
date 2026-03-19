"""AlertPipelineAdapter — 将 AlertPipeline 服务适配到状态机。"""

from __future__ import annotations
from typing import Any
from ..engine import TransitionResult


class AlertPipelineAdapter:
    def __init__(self, alert_pipeline: Any = None, noise_filter: Any = None,
                 decision_engine: Any = None, notification: Any = None) -> None:
        self._pipeline = alert_pipeline
        self._noise_filter = noise_filter
        self._decision_engine = decision_engine
        self._notification = notification

    async def preprocess(self, ctx: dict[str, Any]) -> TransitionResult:
        if self._pipeline and hasattr(self._pipeline, "preprocess"):
            try:
                result = await self._pipeline.preprocess(ctx.get("event"))
                ctx["preprocessed"] = result
                return TransitionResult.SUCCESS
            except Exception:
                return TransitionResult.FAILURE
        return TransitionResult.SUCCESS

    async def noise_filter(self, ctx: dict[str, Any]) -> TransitionResult:
        if self._noise_filter and hasattr(self._noise_filter, "should_filter"):
            filtered = self._noise_filter.should_filter(ctx.get("preprocessed", ctx.get("event")))
            if filtered:
                return TransitionResult.SKIP
        return TransitionResult.SUCCESS

    async def analyze(self, ctx: dict[str, Any]) -> TransitionResult:
        if self._pipeline and hasattr(self._pipeline, "analyze"):
            try:
                analysis = await self._pipeline.analyze(ctx.get("preprocessed", ctx.get("event")))
                ctx["analysis"] = analysis
                return TransitionResult.SUCCESS
            except Exception:
                return TransitionResult.FAILURE
        return TransitionResult.SUCCESS

    async def decide(self, ctx: dict[str, Any]) -> TransitionResult:
        if self._decision_engine and hasattr(self._decision_engine, "decide"):
            decision = await self._decision_engine.decide(ctx.get("analysis"))
            ctx["decision"] = decision
            action = decision.get("action", "notify") if isinstance(decision, dict) else "notify"
            if action == "auto_remediate":
                return TransitionResult.SUCCESS  # mapped to auto_remediate transition
            return TransitionResult.SUCCESS
        return TransitionResult.SUCCESS

    async def notify(self, ctx: dict[str, Any]) -> TransitionResult:
        if self._notification and hasattr(self._notification, "send"):
            try:
                await self._notification.send(
                    channel="default",
                    title="Alert",
                    message=str(ctx.get("analysis", "")),
                    severity=ctx.get("event", {}).get("severity", "info"),
                )
            except Exception:
                pass
        return TransitionResult.SUCCESS
