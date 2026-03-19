"""Scheduler — APScheduler-based task scheduling (replaces node-cron).

Requirements: 9.2, 9.8
"""

from __future__ import annotations

import json
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
        self._action_executor: Callable[[str, dict], Awaitable[Any]] | None = None

    def set_action_executor(self, executor: Callable[[str, dict], Awaitable[Any]]) -> None:
        """Set the executor used to run persisted task actions on reload.

        Typically ``brain_tools.execute`` — injected after container wiring.
        """
        self._action_executor = executor

    async def start(self) -> None:
        # Load persisted tasks before starting the scheduler
        await self._load_persisted_tasks()

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

    async def add_task(self, name: str, cron: str, callback: Callable[..., Awaitable[Any]],
                       enabled: bool = True, metadata: dict[str, Any] | None = None,
                       persist: bool = False) -> str:
        task_id = str(uuid.uuid4())
        task = ScheduledTask(task_id, name, cron, callback, enabled, metadata)
        self._tasks[task_id] = task
        if self._scheduler and self._running and enabled:
            from apscheduler.triggers.cron import CronTrigger
            self._scheduler.add_job(callback, CronTrigger.from_crontab(cron),
                                     id=task_id, name=name, replace_existing=True)
        if persist:
            await self._persist_task_async(task)
        return task_id

    async def remove_task(self, task_id: str) -> None:
        self._tasks.pop(task_id, None)
        if self._scheduler and self._running:
            try:
                self._scheduler.remove_job(task_id)
            except Exception as exc:
                # Job may already have been removed or never registered
                logger.debug("scheduler_remove_job_skipped", task_id=task_id, error=str(exc))
        await self._delete_persisted_task_async(task_id)

    async def update_task(self, task_id: str, *, name: str | None = None,
                          cron: str | None = None, enabled: bool | None = None,
                          metadata: dict[str, Any] | None = None) -> dict[str, Any] | None:
        """Update an existing task in-place. Returns updated task dict or None if not found."""
        task = self._tasks.get(task_id)
        if not task:
            return None

        # Validate cron before mutating anything
        if cron is not None and cron != task.cron:
            from apscheduler.triggers.cron import CronTrigger
            try:
                CronTrigger.from_crontab(cron)
            except (ValueError, KeyError) as exc:
                raise ValueError(f"Invalid cron expression: {cron}") from exc

        was_enabled = task.enabled

        if name is not None:
            task.name = name
        if metadata is not None:
            task.metadata = metadata
        if enabled is not None:
            task.enabled = enabled

        cron_changed = cron is not None and cron != task.cron
        if cron_changed:
            task.cron = cron

        re_enabled = task.enabled and not was_enabled

        # Reschedule APScheduler job
        if self._scheduler and self._running:
            if not task.enabled:
                # Disabled → remove job
                try:
                    self._scheduler.remove_job(task_id)
                except Exception:
                    pass
            elif cron_changed or re_enabled:
                # Cron changed or task re-enabled → reschedule/add
                from apscheduler.triggers.cron import CronTrigger
                trigger = CronTrigger.from_crontab(task.cron)
                try:
                    self._scheduler.reschedule_job(task_id, trigger=trigger)
                except Exception:
                    self._scheduler.add_job(
                        task.callback, trigger,
                        id=task_id, name=task.name, replace_existing=True,
                    )

        # Persist update to DB
        await self._persist_task_async(task)

        return {"id": task.id, "name": task.name, "cron": task.cron, "enabled": task.enabled}


    def get_tasks(self) -> list[dict[str, Any]]:
        return [{"id": t.id, "name": t.name, "cron": t.cron, "enabled": t.enabled,
                 "last_run": t.last_run, "run_count": t.run_count} for t in self._tasks.values()]

    @property
    def is_running(self) -> bool:
        return self._running

    # ------------------------------------------------------------------
    # Persistence helpers
    # ------------------------------------------------------------------

    async def _persist_task_async(self, task: ScheduledTask) -> None:
        try:
            await self._ds.execute(
                "INSERT INTO scheduled_tasks (id, name, cron, enabled, metadata) "
                "VALUES ($1, $2, $3, $4, $5) "
                "ON CONFLICT (id) DO UPDATE SET name=$2, cron=$3, enabled=$4, metadata=$5",
                [task.id, task.name, task.cron, task.enabled,
                 json.dumps(task.metadata, ensure_ascii=False)],
            )
            logger.info("scheduler_task_persisted", task_id=task.id, name=task.name)
        except Exception as exc:
            logger.error("scheduler_task_persist_failed", task_id=task.id, error=str(exc))
            raise

    async def _delete_persisted_task_async(self, task_id: str) -> None:
        try:
            await self._ds.execute(
                "DELETE FROM scheduled_tasks WHERE id = $1", [task_id],
            )
        except Exception as exc:
            logger.error("scheduler_task_delete_failed", task_id=task_id, error=str(exc))
            raise

    async def _load_persisted_tasks(self) -> None:
        """Load tasks from database and rebuild callbacks via action_executor."""
        try:
            rows = await self._ds.query(
                "SELECT id, name, cron, enabled, metadata FROM scheduled_tasks"
            )
        except Exception as exc:
            # Table may not exist yet (migration not run), that's OK
            logger.info("scheduler_load_skipped", reason=str(exc))
            return

        loaded = 0
        for row in rows:
            task_id = row["id"]
            if task_id in self._tasks:
                continue  # already registered in-memory
            name = row["name"]
            cron = row["cron"]
            enabled = row.get("enabled", True)
            raw_meta = row.get("metadata")
            if isinstance(raw_meta, str):
                try:
                    metadata = json.loads(raw_meta)
                except (json.JSONDecodeError, ValueError):
                    metadata = {}
            elif isinstance(raw_meta, dict):
                metadata = raw_meta
            else:
                metadata = {}

            callback = self._build_callback_from_metadata(metadata)
            task = ScheduledTask(task_id, name, cron, callback, enabled, metadata)
            self._tasks[task_id] = task
            loaded += 1

        if loaded:
            logger.info("scheduler_tasks_loaded", count=loaded)

    def _build_callback_from_metadata(self, metadata: dict[str, Any]) -> Callable[..., Awaitable[Any]]:
        """Build an async callback from persisted metadata.action."""
        action = metadata.get("action", {})
        tool_name = action.get("tool", "")
        tool_params = action.get("params", {})

        async def _restored_callback() -> None:
            if not self._action_executor:
                logger.error("scheduler_action_executor_not_set", tool=tool_name, source="persisted")
                return
            if not tool_name:
                logger.warning("scheduler_action_missing_tool_name", source="persisted")
                return
            try:
                await self._action_executor(tool_name, tool_params)
                logger.info("scheduled_action_executed", tool=tool_name, source="persisted")
            except Exception as exc:
                logger.warning("scheduled_action_failed", tool=tool_name, error=str(exc))

        return _restored_callback
