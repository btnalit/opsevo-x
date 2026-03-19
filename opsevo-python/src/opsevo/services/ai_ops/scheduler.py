"""Scheduler — APScheduler-based task scheduling (replaces node-cron).

Requirements: 9.2, 9.8
"""

from __future__ import annotations

import uuid
from typing import Any, Callable, Awaitable

from opsevo.data.datastore import DataStore
from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class ScheduledTask:
    def __init__(self, task_id: str, name: str, cron: str, callback: Callable[..., Awaitable[Any]],
                 enabled: bool = True, metadata: dict[str, Any] | None = None):
        self.id = task_id
        self.name = name
        self.cron = cron
        self.callback = callback
        self.enabled = enabled
        self.metadata = metadata or {}
        self.last_run: int = 0
        self.run_count: int = 0


class Scheduler:
    def __init__(self, datastore: DataStore):
        self._ds = datastore
        self._tasks: dict[str, ScheduledTask] = {}
        self._scheduler: Any = None
        self._running = False

    async def start(self) -> None:
        try:
            from apscheduler.schedulers.asyncio import AsyncIOScheduler
            from apscheduler.triggers.cron import CronTrigger
            self._scheduler = AsyncIOScheduler()
            for task in self._tasks.values():
                if task.enabled:
                    self._scheduler.add_job(
                        task.callback, CronTrigger.from_crontab(task.cron),
                        id=task.id, name=task.name, replace_existing=True,
                    )
            self._scheduler.start()
            self._running = True
            logger.info("scheduler_started", tasks=len(self._tasks))
        except ImportError:
            logger.warning("apscheduler_not_installed_scheduler_disabled")

    async def stop(self) -> None:
        if self._scheduler and self._running:
            self._scheduler.shutdown(wait=False)
            self._running = False
            logger.info("scheduler_stopped")

    def add_task(self, name: str, cron: str, callback: Callable[..., Awaitable[Any]],
                 enabled: bool = True, metadata: dict[str, Any] | None = None) -> str:
        task_id = str(uuid.uuid4())
        task = ScheduledTask(task_id, name, cron, callback, enabled, metadata)
        self._tasks[task_id] = task
        if self._scheduler and self._running and enabled:
            from apscheduler.triggers.cron import CronTrigger
            self._scheduler.add_job(callback, CronTrigger.from_crontab(cron),
                                     id=task_id, name=name, replace_existing=True)
        return task_id

    def remove_task(self, task_id: str) -> None:
        self._tasks.pop(task_id, None)
        if self._scheduler and self._running:
            try:
                self._scheduler.remove_job(task_id)
            except Exception:
                pass

    def get_tasks(self) -> list[dict[str, Any]]:
        return [{"id": t.id, "name": t.name, "cron": t.cron, "enabled": t.enabled,
                 "last_run": t.last_run, "run_count": t.run_count} for t in self._tasks.values()]

    @property
    def is_running(self) -> bool:
        return self._running
