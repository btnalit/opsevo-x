"""FaultHealer — auto-remediation using Profile remediation_templates (device-agnostic).

Requirements: 9.2, 1.7, 1.10
"""

from __future__ import annotations

import time
import uuid
from typing import Any

from opsevo.data.datastore import DataStore
from opsevo.drivers.base import DeviceDriver
from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class FaultHealer:
    def __init__(self, datastore: DataStore):
        self._ds = datastore
        self._ai_adapter: Any = None

    def set_ai_adapter(self, adapter: Any) -> None:
        self._ai_adapter = adapter

    async def heal(self, alert: dict[str, Any], driver: DeviceDriver) -> dict[str, Any]:
        manifest = driver.get_capability_manifest()
        templates = manifest.remediation_templates
        fault_type = self._classify_fault(alert)
        template = templates.get(fault_type)
        if not template:
            return await self._ai_heal(alert, driver)
        script = self._render_template(template, alert)
        result = await driver.execute("run_script", {"script": script})
        execution_id = str(uuid.uuid4())
        await self._record_execution(execution_id, alert, script, result)
        return {"execution_id": execution_id, "success": result.success, "output": result.data, "source": "template"}

    async def _ai_heal(self, alert: dict[str, Any], driver: DeviceDriver) -> dict[str, Any]:
        if not self._ai_adapter:
            return {"success": False, "error": "No template and no AI adapter available"}
        manifest = driver.get_capability_manifest()
        prompt = (
            f"Generate a remediation script for device type {manifest.vendor} {manifest.model}.\n"
            f"Script language: {manifest.script_language}\n"
            f"Alert: {alert.get('message', '')}\n"
            f"Severity: {alert.get('severity', 'unknown')}"
        )
        resp = await self._ai_adapter.chat([{"role": "user", "content": prompt}])
        content = resp.get("content", "") if isinstance(resp, dict) else str(resp)
        return {"success": True, "script": content, "source": "ai", "dry_run": True}

    @staticmethod
    def _classify_fault(alert: dict[str, Any]) -> str:
        msg = alert.get("message", "").lower()
        if "interface" in msg and "down" in msg:
            return "interface_down"
        if "cpu" in msg:
            return "high_cpu"
        if "memory" in msg:
            return "high_memory"
        if "disk" in msg:
            return "disk_full"
        return "unknown"

    @staticmethod
    def _render_template(template: str, alert: dict[str, Any]) -> str:
        result = template
        for key, value in alert.items():
            result = result.replace(f"{{{key}}}", str(value))
        return result

    async def _record_execution(self, exec_id: str, alert: dict[str, Any], script: str, result: Any) -> None:
        try:
            await self._ds.execute(
                "INSERT INTO remediation_executions (id, alert_id, script, success, output, timestamp) "
                "VALUES ($1,$2,$3,$4,$5,$6)",
                (exec_id, alert.get("id", ""), script, getattr(result, "success", False),
                 getattr(result, "data", ""), int(time.time() * 1000)),
            )
        except Exception:
            logger.warning("remediation_record_failed", exec_id=exec_id)
