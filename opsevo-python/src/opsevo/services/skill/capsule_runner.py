"""CapsuleRunner — 技能胶囊子进程执行器。

通过 subprocess 启动 capsule 入口脚本，stdin/stdout 传递 JSON 数据，
支持超时控制和工作目录隔离。
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from typing import Any

import structlog

logger = structlog.get_logger(__name__)

# runtime → 解释器映射
_RUNTIME_INTERPRETERS: dict[str, str] = {
    "python": sys.executable,
    "node": "node",
    "bash": "bash",
}


class CapsuleRunner:
    """通过 subprocess 执行 capsule 入口脚本。"""

    async def run(
        self,
        capsule_dir: Path,
        input_data: dict[str, Any],
        runtime: str = "python",
        timeout: float = 30.0,
    ) -> dict[str, Any]:
        """执行 capsule 并返回 JSON 结果。

        - stdin 传入 JSON
        - stdout 读取 JSON 结果
        - stderr 捕获为诊断日志
        - 超时自动 kill
        - 工作目录隔离到 capsule_dir
        """
        capsule_dir = Path(capsule_dir)

        # 读取 capsule.json 获取 entrypoint 和 runtime
        capsule_meta = self._load_capsule_meta(capsule_dir)
        entrypoint = capsule_meta.get("entrypoint", "main.py")
        effective_runtime = capsule_meta.get("runtime", runtime)

        interpreter = self._resolve_interpreter(effective_runtime)
        entrypoint_path = str(capsule_dir / entrypoint)
        stdin_bytes = json.dumps(input_data, ensure_ascii=False).encode("utf-8")

        logger.info(
            "capsule_run_start",
            capsule_dir=str(capsule_dir),
            runtime=effective_runtime,
            interpreter=interpreter,
            entrypoint=entrypoint,
            timeout=timeout,
        )

        try:
            proc = await asyncio.create_subprocess_exec(
                interpreter,
                entrypoint_path,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(capsule_dir),
            )
        except FileNotFoundError:
            msg = f"Interpreter not found: {interpreter}"
            logger.error("capsule_interpreter_not_found", interpreter=interpreter)
            return {"status": "error", "error": msg}
        except OSError as exc:
            msg = f"Failed to start subprocess: {exc}"
            logger.error("capsule_start_failed", error=str(exc))
            return {"status": "error", "error": msg}

        try:
            stdout_bytes, stderr_bytes = await asyncio.wait_for(
                proc.communicate(input=stdin_bytes),
                timeout=timeout,
            )
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            logger.warning("capsule_timeout", timeout=timeout, capsule_dir=str(capsule_dir))
            return {"status": "error", "error": f"Capsule execution timed out after {timeout}s"}

        stderr_text = stderr_bytes.decode("utf-8", errors="replace").strip()
        if stderr_text:
            logger.info("capsule_stderr", stderr=stderr_text, capsule_dir=str(capsule_dir))

        # 非零 exit code → 失败
        if proc.returncode != 0:
            logger.warning(
                "capsule_nonzero_exit",
                returncode=proc.returncode,
                stderr=stderr_text,
                capsule_dir=str(capsule_dir),
            )
            return {
                "status": "error",
                "error": f"Capsule exited with code {proc.returncode}",
                "stderr": stderr_text,
            }

        # 解析 stdout JSON
        stdout_text = stdout_bytes.decode("utf-8", errors="replace").strip()
        try:
            result = json.loads(stdout_text)
        except (json.JSONDecodeError, ValueError) as exc:
            logger.warning(
                "capsule_invalid_json",
                stdout=stdout_text[:500],
                error=str(exc),
                capsule_dir=str(capsule_dir),
            )
            return {
                "status": "error",
                "error": f"Capsule stdout is not valid JSON: {exc}",
                "raw_stdout": stdout_text[:1000],
            }

        logger.info("capsule_run_success", capsule_dir=str(capsule_dir))
        return result

    @staticmethod
    def _resolve_interpreter(runtime: str) -> str:
        """根据 runtime 字段选择解释器路径。"""
        interpreter = _RUNTIME_INTERPRETERS.get(runtime)
        if interpreter is None:
            raise ValueError(f"Unsupported runtime: {runtime!r}. Supported: {list(_RUNTIME_INTERPRETERS)}")
        return interpreter

    @staticmethod
    def _load_capsule_meta(capsule_dir: Path) -> dict[str, Any]:
        """读取 capsule.json 元数据。"""
        meta_path = capsule_dir / "capsule.json"
        if not meta_path.is_file():
            logger.debug("capsule_no_meta", path=str(meta_path))
            return {}
        try:
            return json.loads(meta_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as exc:
            logger.warning("capsule_meta_read_error", path=str(meta_path), error=str(exc))
            return {}
