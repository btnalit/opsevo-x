"""
ConcurrencyController - 增强的并发控制器

- 优先级队列：高优先级任务优先处理
- 超时保护：任务超时自动取消
- 背压机制：队列使用率过高时拒绝低优先级任务
- 统计信息：处理时间、成功/失败计数
"""

from __future__ import annotations

import asyncio
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Generic, TypeVar

import structlog

logger = structlog.get_logger(__name__)

T = TypeVar("T")
R = TypeVar("R")


@dataclass
class ConcurrencyConfig:
    max_concurrent: int = 5
    max_queue_size: int = 100
    task_timeout: float = 30.0  # seconds
    enable_priority_queue: bool = True
    enable_backpressure: bool = True
    backpressure_threshold: float = 0.8  # 0-1


@dataclass
class ConcurrencyStatus:
    active: int = 0
    queued: int = 0
    max_concurrent: int = 5
    queue_capacity: int = 100
    queue_usage_percent: float = 0.0
    is_paused: bool = False
    is_backpressure_active: bool = False
    avg_processing_time_ms: float = 0.0
    total_processed: int = 0
    total_dropped: int = 0
    total_timed_out: int = 0


@dataclass
class _QueuedTask:
    item: Any
    priority: int
    enqueued_at: float
    future: asyncio.Future[Any] = field(default=None)  # type: ignore[assignment]


class ConcurrencyController:
    """增强的并发控制器，支持优先级队列、超时保护和背压。"""

    _MAX_TIME_SAMPLES = 100

    def __init__(self, config: ConcurrencyConfig | None = None) -> None:
        self._config = config or ConcurrencyConfig()
        self._processor: Callable[..., Awaitable[Any]] | None = None
        self._queue: list[_QueuedTask] = []
        self._active_count = 0
        self._paused = False

        # stats
        self._total_processed = 0
        self._total_dropped = 0
        self._total_timed_out = 0
        self._processing_times: deque[float] = deque(maxlen=self._MAX_TIME_SAMPLES)

    def set_processor(self, processor: Callable[..., Awaitable[Any]]) -> None:
        self._processor = processor

    # ------------------------------------------------------------------
    async def enqueue(self, item: Any, priority: int = 5) -> Any:
        if self._processor is None:
            raise RuntimeError("Task processor not set. Call set_processor() first.")

        # backpressure check
        if self._config.enable_backpressure and self._backpressure_triggered():
            if priority > 5:
                self._total_dropped += 1
                raise RuntimeError("Backpressure active: system overloaded, please retry later")

        # queue full check
        if len(self._queue) >= self._config.max_queue_size:
            if self._config.enable_priority_queue:
                lowest_idx = self._find_lowest_priority_idx()
                if lowest_idx != -1 and self._queue[lowest_idx].priority > priority:
                    dropped = self._queue.pop(lowest_idx)
                    if not dropped.future.done():
                        dropped.future.set_exception(RuntimeError("Dropped: replaced by higher priority task"))
                    self._total_dropped += 1
                else:
                    self._total_dropped += 1
                    raise RuntimeError(f"Queue full ({self._config.max_queue_size}), priority not high enough")
            else:
                self._total_dropped += 1
                raise RuntimeError(f"Queue full ({self._config.max_queue_size})")

        loop = asyncio.get_running_loop()
        task = _QueuedTask(item=item, priority=priority, enqueued_at=time.monotonic(), future=loop.create_future())

        if self._config.enable_priority_queue:
            self._insert_by_priority(task)
        else:
            self._queue.append(task)

        self._process_queue()
        return await task.future

    def get_status(self) -> ConcurrencyStatus:
        return ConcurrencyStatus(
            active=self._active_count,
            queued=len(self._queue),
            max_concurrent=self._config.max_concurrent,
            queue_capacity=self._config.max_queue_size,
            queue_usage_percent=self._queue_usage_percent(),
            is_paused=self._paused,
            is_backpressure_active=self._config.enable_backpressure and self._backpressure_triggered(),
            avg_processing_time_ms=self._avg_processing_time(),
            total_processed=self._total_processed,
            total_dropped=self._total_dropped,
            total_timed_out=self._total_timed_out,
        )

    def pause(self) -> None:
        self._paused = True

    def resume(self) -> None:
        self._paused = False
        self._process_queue()

    async def drain(self) -> None:
        while self._active_count > 0 or self._queue:
            await asyncio.sleep(0.1)

    # ------------------------------------------------------------------
    # internals
    # ------------------------------------------------------------------
    def _process_queue(self) -> None:
        if self._paused:
            return
        while self._active_count < self._config.max_concurrent and self._queue:
            task = self._queue.pop(0)
            asyncio.ensure_future(self._run_task(task))

    async def _run_task(self, task: _QueuedTask) -> None:
        self._active_count += 1
        start = time.monotonic()
        try:
            result = await asyncio.wait_for(
                self._processor(task.item),  # type: ignore[misc]
                timeout=self._config.task_timeout,
            )
            self._processing_times.append((time.monotonic() - start) * 1000)
            self._total_processed += 1
            if not task.future.done():
                task.future.set_result(result)
        except asyncio.TimeoutError:
            self._total_timed_out += 1
            if not task.future.done():
                task.future.set_exception(RuntimeError(f"Task timeout after {self._config.task_timeout}s"))
        except Exception as exc:
            if not task.future.done():
                task.future.set_exception(exc)
        finally:
            self._active_count -= 1
            self._process_queue()

    def _insert_by_priority(self, task: _QueuedTask) -> None:
        idx = len(self._queue)
        for i, t in enumerate(self._queue):
            if t.priority > task.priority:
                idx = i
                break
        self._queue.insert(idx, task)

    def _find_lowest_priority_idx(self) -> int:
        if not self._queue:
            return -1
        idx = 0
        for i in range(1, len(self._queue)):
            if self._queue[i].priority > self._queue[idx].priority:
                idx = i
        return idx

    def _backpressure_triggered(self) -> bool:
        return (self._queue_usage_percent() / 100) >= self._config.backpressure_threshold

    def _queue_usage_percent(self) -> float:
        if self._config.max_queue_size == 0:
            return 0.0
        return (len(self._queue) / self._config.max_queue_size) * 100

    def _avg_processing_time(self) -> float:
        if not self._processing_times:
            return 0.0
        return sum(self._processing_times) / len(self._processing_times)


def create_concurrency_controller(
    processor: Callable[..., Awaitable[Any]],
    config: ConcurrencyConfig | None = None,
) -> ConcurrencyController:
    ctrl = ConcurrencyController(config)
    ctrl.set_processor(processor)
    return ctrl
