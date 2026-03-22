"""
文件上传 API 路由
/api/ai-ops/rag/knowledge/upload/* 端点

device_id 通过 query param (?deviceId=xxx) 传入，可选。
"""

from __future__ import annotations

import time
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Path, UploadFile, File, Query, Request
from fastapi.responses import JSONResponse

from .deps import get_current_user, get_device_id
from opsevo.utils.logger import get_logger

logger = get_logger(__name__)

router = APIRouter(
    prefix="/api/ai-ops/rag/knowledge/upload",
    tags=["file-upload"],
)


def _get_knowledge_base(request: Request):
    provider = getattr(request.app.state.container, "knowledge_base", None)
    if provider is None:
        raise HTTPException(503, "Knowledge base service not available")
    return provider()


# Max chunk size for splitting large files (approx 2000 chars per chunk)
_CHUNK_SIZE = 2000


def _extract_text(raw: bytes, ext: str) -> str:
    """Best-effort text extraction from uploaded file bytes."""
    if ext in (".txt", ".md", ".csv", ".json", ".yaml", ".yml"):
        for enc in ("utf-8", "utf-8-sig", "gbk", "latin-1"):
            try:
                return raw.decode(enc)
            except (UnicodeDecodeError, ValueError):
                continue
        return raw.decode("utf-8", errors="replace")
    # PDF / DOCX — return empty; full parsing requires external libs
    return ""


def _chunk_text(text: str, chunk_size: int = _CHUNK_SIZE) -> list[str]:
    """Split text into chunks, preferring paragraph boundaries."""
    if len(text) <= chunk_size:
        return [text] if text.strip() else []
    paragraphs = text.split("\n\n")
    chunks: list[str] = []
    current = ""
    for para in paragraphs:
        if len(current) + len(para) + 2 > chunk_size and current:
            chunks.append(current.strip())
            current = para
        else:
            current = current + "\n\n" + para if current else para
    if current.strip():
        chunks.append(current.strip())
    # Force-split any oversized chunks
    final: list[str] = []
    for c in chunks:
        while len(c) > chunk_size:
            final.append(c[:chunk_size])
            c = c[chunk_size:]
        if c.strip():
            final.append(c)
    return final

# 支持的文件类型
SUPPORTED_FILE_TYPES = [
    {"extension": ".txt", "mime": "text/plain", "maxSize": 10 * 1024 * 1024},
    {"extension": ".md", "mime": "text/markdown", "maxSize": 10 * 1024 * 1024},
    {"extension": ".pdf", "mime": "application/pdf", "maxSize": 50 * 1024 * 1024},
    {"extension": ".docx", "mime": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "maxSize": 50 * 1024 * 1024},
    {"extension": ".csv", "mime": "text/csv", "maxSize": 10 * 1024 * 1024},
    {"extension": ".json", "mime": "application/json", "maxSize": 10 * 1024 * 1024},
    {"extension": ".yaml", "mime": "application/x-yaml", "maxSize": 10 * 1024 * 1024},
    {"extension": ".yml", "mime": "application/x-yaml", "maxSize": 10 * 1024 * 1024},
]

MAX_FILE_SIZE = max(t["maxSize"] for t in SUPPORTED_FILE_TYPES)
MAX_FILES = 10

# 简单内存进度存储
_progress_store: dict[str, dict[str, Any]] = {}

# TTL for completed progress entries (1 hour)
_PROGRESS_TTL = 3600


def _cleanup_expired_progress() -> None:
    """Remove completed progress entries older than _PROGRESS_TTL seconds."""
    now = time.time()
    expired = [
        key
        for key, entry in _progress_store.items()
        if entry.get("status") == "completed"
        and now - entry.get("completedAt", now) > _PROGRESS_TTL
    ]
    for key in expired:
        del _progress_store[key]


def _get_extension(filename: str) -> str:
    dot = filename.rfind(".")
    return filename[dot:].lower() if dot >= 0 else ""


def _generate_progress_id() -> str:
    return f"upload_{int(time.time())}_{uuid.uuid4().hex[:7]}"


def _format_upload_error(exc: Exception) -> str:
    """Normalize backend exception to user-facing API error text."""
    msg = (str(exc) or "").strip()
    if not msg:
        msg = exc.__class__.__name__
    lower = msg.lower()
    if "no api key configured for embedding" in lower:
        return "未配置可用的嵌入 API Key，请先在 AI 服务配置中添加可用密钥"
    if "embedding api failed" in lower or "embedding network error" in lower:
        return f"向量化服务调用失败：{msg}"
    if "vector" in lower and "dimension" in lower:
        return f"向量维度不匹配：{msg}"
    if len(msg) > 300:
        return msg[:300] + "..."
    return msg


# ---------------------------------------------------------------------------
# GET /upload/types — 获取支持的文件类型
# ---------------------------------------------------------------------------
@router.get("/types")
async def get_supported_types(device_id: str | None = Depends(get_device_id), user=Depends(get_current_user)) -> dict:
    return {"success": True, "data": SUPPORTED_FILE_TYPES}


# ---------------------------------------------------------------------------
# POST /upload/validate — 验证文件（不实际上传）
# ---------------------------------------------------------------------------
@router.post("/validate")
async def validate_files(
    device_id: str | None = Depends(get_device_id),
    files: list[UploadFile] = File(...),
    user=Depends(get_current_user),
) -> dict:
    if not files:
        raise HTTPException(400, "没有上传文件")

    results = []
    for f in files:
        ext = _get_extension(f.filename or "")
        supported = any(t["extension"] == ext for t in SUPPORTED_FILE_TYPES)
        results.append({"filename": f.filename, "valid": supported, "extension": ext})

    valid_count = sum(1 for r in results if r["valid"])
    return {
        "success": True,
        "data": results,
        "summary": {"total": len(results), "valid": valid_count, "invalid": len(results) - valid_count},
    }


# ---------------------------------------------------------------------------
# POST /upload — 上传单个文件到知识库
# ---------------------------------------------------------------------------
@router.post("")
async def upload_file(
    request: Request,
    device_id: str | None = Depends(get_device_id),
    file: UploadFile = File(...),
    user=Depends(get_current_user),
) -> JSONResponse:
    _cleanup_expired_progress()
    if not file.filename:
        raise HTTPException(400, "没有上传文件")

    ext = _get_extension(file.filename)
    if not any(t["extension"] == ext for t in SUPPORTED_FILE_TYPES):
        raise HTTPException(400, f"不支持的文件类型: {ext}")

    progress_id = _generate_progress_id()
    _progress_store[progress_id] = {
        "id": progress_id,
        "filename": file.filename,
        "status": "processing",
        "progress": 10,
        "message": "正在解析文件...",
        "startedAt": time.time(),
    }

    raw = await file.read()
    entries_created: list[dict[str, Any]] = []

    try:
        text = _extract_text(raw, ext)
        if text.strip():
            kb = _get_knowledge_base(request)
            chunks = _chunk_text(text)
            _progress_store[progress_id].update(progress=30, message=f"正在写入 {len(chunks)} 个分块...")
            for i, chunk in enumerate(chunks):
                meta = {
                    "source": "file-upload",
                    "filename": file.filename,
                    "fileType": ext,
                    "chunkIndex": i,
                    "totalChunks": len(chunks),
                    "deviceId": device_id,
                }
                doc_id = await kb.add_entry(chunk, metadata=meta, tags=["file-upload", ext.lstrip(".")])
                entries_created.append({"id": doc_id, "chunkIndex": i, "length": len(chunk)})
                _progress_store[progress_id]["progress"] = 30 + int(60 * (i + 1) / len(chunks))
        else:
            logger.warning("file_upload_no_text", filename=file.filename, ext=ext)

        _progress_store[progress_id].update(
            status="completed", progress=100, message="处理完成", completedAt=time.time()
        )
        return JSONResponse(
            status_code=201,
            content={
                "success": True,
                "data": {
                    "filename": file.filename,
                    "size": len(raw),
                    "entries": entries_created,
                    "entriesCreated": len(entries_created),
                },
                "progressId": progress_id,
            },
        )
    except Exception as exc:
        msg = _format_upload_error(exc)
        logger.error("file_upload_error", filename=file.filename, error=msg, exc_info=True)
        _progress_store[progress_id].update(
            status="failed",
            message=msg,
            completedAt=time.time(),
        )
        return JSONResponse(
            status_code=502,
            content={
                "success": False,
                "error": msg,
                "progressId": progress_id,
            },
        )


# ---------------------------------------------------------------------------
# POST /upload/batch — 批量上传文件到知识库
# ---------------------------------------------------------------------------
@router.post("/batch")
async def batch_upload_files(
    request: Request,
    device_id: str | None = Depends(get_device_id),
    files: list[UploadFile] = File(...),
    user=Depends(get_current_user),
) -> JSONResponse:
    _cleanup_expired_progress()
    if not files:
        raise HTTPException(400, "没有上传文件")
    if len(files) > MAX_FILES:
        raise HTTPException(400, f"文件数量超过限制（最多 {MAX_FILES} 个）")

    progress_id = _generate_progress_id()
    _progress_store[progress_id] = {
        "id": progress_id,
        "filename": f"批量上传 ({len(files)} 个文件)",
        "status": "processing",
        "progress": 10,
        "startedAt": time.time(),
    }

    kb = _get_knowledge_base(request)
    results = []
    total_entries = 0

    for fi, f in enumerate(files):
        fname = f.filename or f"file_{fi}"
        ext = _get_extension(fname)
        raw = await f.read()
        file_entries: list[dict[str, Any]] = []
        success = True
        error_msg = None

        try:
            if not any(t["extension"] == ext for t in SUPPORTED_FILE_TYPES):
                raise ValueError(f"不支持的文件类型: {ext}")
            text = _extract_text(raw, ext)
            if text.strip():
                chunks = _chunk_text(text)
                for i, chunk in enumerate(chunks):
                    meta = {
                        "source": "file-upload",
                        "filename": fname,
                        "fileType": ext,
                        "chunkIndex": i,
                        "totalChunks": len(chunks),
                        "deviceId": device_id,
                    }
                    doc_id = await kb.add_entry(chunk, metadata=meta, tags=["file-upload", ext.lstrip(".")])
                    file_entries.append({"id": doc_id, "chunkIndex": i, "length": len(chunk)})
        except Exception as exc:
            success = False
            error_msg = _format_upload_error(exc)
            logger.error("batch_upload_file_error", filename=fname, error=error_msg, exc_info=True)

        total_entries += len(file_entries)
        results.append({
            "filename": fname,
            "size": len(raw),
            "success": success,
            "error": error_msg,
            "entries": file_entries,
            "entriesCreated": len(file_entries),
        })
        _progress_store[progress_id]["progress"] = 10 + int(80 * (fi + 1) / len(files))

    success_count = sum(1 for r in results if r["success"])
    _progress_store[progress_id].update(
        status="completed", progress=100, completedAt=time.time()
    )

    if success_count == 0:
        first_error = next((r.get("error") for r in results if r.get("error")), "所有文件处理失败")
        return JSONResponse(
            status_code=502,
            content={
                "success": False,
                "error": f"批量上传失败：{first_error}",
                "data": results,
                "summary": {
                    "total": len(files),
                    "success": success_count,
                    "failed": len(files) - success_count,
                    "entriesCreated": total_entries,
                },
                "progressId": progress_id,
            },
        )

    return JSONResponse(
        status_code=201,
        content={
            "success": True,
            "data": results,
            "summary": {
                "total": len(files),
                "success": success_count,
                "failed": len(files) - success_count,
                "entriesCreated": total_entries,
            },
            "progressId": progress_id,
        },
    )


# ---------------------------------------------------------------------------
# GET /upload/progress/{progress_id} — 获取上传进度
# ---------------------------------------------------------------------------
@router.get("/progress/{progress_id}")
async def get_upload_progress(
    device_id: str | None = Depends(get_device_id),
    progress_id: str = Path(...),
    user=Depends(get_current_user),
) -> dict:
    progress = _progress_store.get(progress_id)
    if not progress:
        raise HTTPException(404, "进度信息不存在或已过期")
    return {"success": True, "data": progress}
