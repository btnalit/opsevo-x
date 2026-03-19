"""
Prompt Templates API 路由
/api/prompt-templates/* 端点

接入 DataStore 实现完整 CRUD。
device_id 通过 query param (?deviceId=xxx) 传入，可选。
"""

from __future__ import annotations

import json
import re
import uuid

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request

from .deps import get_current_user, get_datastore

router = APIRouter(prefix="/api/prompt-templates", tags=["prompt-templates"])

# Available system placeholders
_SYSTEM_PLACEHOLDERS = [
    {"name": "device_name", "description": "设备名称"},
    {"name": "device_ip", "description": "设备 IP 地址"},
    {"name": "device_type", "description": "设备类型"},
    {"name": "current_time", "description": "当前时间"},
    {"name": "user_name", "description": "当前用户名"},
    {"name": "context", "description": "上下文信息"},
]


def _extract_placeholders(content: str) -> list[str]:
    """Extract {{placeholder}} names from template content."""
    return list(set(re.findall(r"\{\{(\w+)\}\}", content)))


# ==================== 特殊路由（放在参数路由之前） ====================
@router.get("/placeholders")
async def get_placeholders(device_id: str = Query(None, alias="deviceId"), user=Depends(get_current_user)) -> dict:
    return {"success": True, "data": _SYSTEM_PLACEHOLDERS}


@router.get("/default")
async def get_default_template(
    device_id: str = Query(None, alias="deviceId"), category: str = Query(None),
    ds=Depends(get_datastore), user=Depends(get_current_user),
) -> dict:
    if category:
        row = await ds.query_one(
            "SELECT * FROM prompt_templates WHERE device_id=$1 AND is_default=true AND category=$2",
            [device_id, category],
        )
    else:
        row = await ds.query_one(
            "SELECT * FROM prompt_templates WHERE device_id=$1 AND is_default=true", [device_id]
        )
    if not row:
        raise HTTPException(404, "未找到默认模板")
    return {"success": True, "data": row}


# ==================== 模板覆盖路由 ====================
@router.get("/overrides")
async def get_overrides(device_id: str = Query(None, alias="deviceId"), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    rows = await ds.query(
        "SELECT * FROM template_overrides WHERE device_id=$1", [device_id]
    )
    return {"success": True, "data": rows}


@router.post("/overrides")
async def set_override(device_id: str = Query(None, alias="deviceId"), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    sys_name = body.get("systemTemplateName", "")
    custom_id = body.get("customTemplateId", "")
    if not sys_name or not custom_id:
        raise HTTPException(400, "系统模板名称和自定义模板ID为必填项")
    # Verify custom template exists
    tpl = await ds.query_one("SELECT id FROM prompt_templates WHERE id=$1 AND device_id=$2", [custom_id, device_id])
    if not tpl:
        raise HTTPException(404, "自定义模板不存在")
    await ds.execute(
        "INSERT INTO template_overrides (device_id, system_template_name, custom_template_id) "
        "VALUES ($1, $2, $3) ON CONFLICT (device_id, system_template_name) DO UPDATE SET custom_template_id=$3",
        [device_id, sys_name, custom_id],
    )
    rows = await ds.query("SELECT * FROM template_overrides WHERE device_id=$1", [device_id])
    return {"success": True, "data": rows}


@router.delete("/overrides/{system_template_name}")
async def clear_override(device_id: str = Query(None, alias="deviceId"), system_template_name: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    await ds.execute(
        "DELETE FROM template_overrides WHERE device_id=$1 AND system_template_name=$2",
        [device_id, system_template_name],
    )
    rows = await ds.query("SELECT * FROM template_overrides WHERE device_id=$1", [device_id])
    return {"success": True, "data": rows}


# ==================== CRUD 路由 ====================
@router.get("")
async def get_templates(
    device_id: str = Query(None, alias="deviceId"),
    category: str = Query(None), search: str = Query(None),
    page: int = Query(1), page_size: int = Query(10),
    ds=Depends(get_datastore), user=Depends(get_current_user),
) -> dict:
    base = "SELECT * FROM prompt_templates WHERE device_id=$1"
    params: list = [device_id]
    idx = 2
    if category:
        base += f" AND category=${idx}"
        params.append(category)
        idx += 1
    if search:
        base += f" AND (name ILIKE ${idx} OR content ILIKE ${idx})"
        params.append(f"%{search}%")
        idx += 1
    base += " ORDER BY created_at DESC"
    rows = await ds.query(base, params)
    total = len(rows)
    start = (page - 1) * page_size
    return {
        "success": True,
        "data": rows[start:start + page_size],
        "pagination": {"page": page, "pageSize": page_size, "total": total},
    }


@router.post("")
async def create_template(device_id: str = Query(None, alias="deviceId"), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    name = body.get("name", "")
    content = body.get("content", "")
    if not name or not content:
        raise HTTPException(400, "名称和内容为必填项")
    tid = str(uuid.uuid4())
    placeholders = _extract_placeholders(content)
    await ds.execute(
        "INSERT INTO prompt_templates (id, device_id, name, content, description, category, placeholders, is_default, created_at) "
        "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())",
        [tid, device_id, name, content, body.get("description", ""),
         body.get("category", "general"), json.dumps(placeholders), body.get("isDefault", False)],
    )
    row = await ds.query_one("SELECT * FROM prompt_templates WHERE id=$1", [tid])
    return {"success": True, "data": row}


@router.get("/{template_id}")
async def get_template_by_id(device_id: str = Query(None, alias="deviceId"), template_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one(
        "SELECT * FROM prompt_templates WHERE id=$1 AND device_id=$2", [template_id, device_id]
    )
    if not row:
        raise HTTPException(404, "模板不存在")
    return {"success": True, "data": row}


@router.put("/{template_id}")
async def update_template(device_id: str = Query(None, alias="deviceId"), template_id: str = Path(...), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    existing = await ds.query_one("SELECT * FROM prompt_templates WHERE id=$1 AND device_id=$2", [template_id, device_id])
    if not existing:
        raise HTTPException(404, "模板不存在")
    sets, params, idx = [], [], 1
    for k in ("name", "content", "description", "category", "is_default"):
        camel = k.replace("_d", "D").replace("_n", "N").replace("_c", "C")  # snake to camel rough
        val = body.get(k) or body.get(camel)
        if val is not None:
            sets.append(f"{k} = ${idx}")
            params.append(val)
            idx += 1
    # Re-extract placeholders if content changed
    new_content = body.get("content")
    if new_content:
        sets.append(f"placeholders = ${idx}")
        params.append(json.dumps(_extract_placeholders(new_content)))
        idx += 1
    if sets:
        params.append(template_id)
        await ds.execute(f"UPDATE prompt_templates SET {', '.join(sets)} WHERE id = ${idx}", tuple(params))
    row = await ds.query_one("SELECT * FROM prompt_templates WHERE id=$1", [template_id])
    return {"success": True, "data": row}


@router.delete("/{template_id}")
async def delete_template(device_id: str = Query(None, alias="deviceId"), template_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    existing = await ds.query_one("SELECT * FROM prompt_templates WHERE id=$1 AND device_id=$2", [template_id, device_id])
    if not existing:
        raise HTTPException(404, "模板不存在")
    await ds.execute("DELETE FROM prompt_templates WHERE id=$1 AND device_id=$2", [template_id, device_id])
    return {"success": True, "message": "Template deleted"}


@router.post("/{template_id}/render")
async def render_template(device_id: str = Query(None, alias="deviceId"), template_id: str = Path(...), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one("SELECT * FROM prompt_templates WHERE id=$1 AND device_id=$2", [template_id, device_id])
    if not row:
        raise HTTPException(404, "模板不存在")
    body = await request.json()
    content = row.get("content", "")
    # Replace {{placeholder}} with provided values
    for key, value in body.items():
        content = content.replace(f"{{{{{key}}}}}", str(value))
    return {"success": True, "data": {"rendered": content}}


@router.post("/{template_id}/default")
async def set_default_template(device_id: str = Query(None, alias="deviceId"), template_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    existing = await ds.query_one("SELECT * FROM prompt_templates WHERE id=$1 AND device_id=$2", [template_id, device_id])
    if not existing:
        raise HTTPException(404, "模板不存在")
    category = existing.get("category", "general")

    async def _set(tx):
        await tx.execute("UPDATE prompt_templates SET is_default=false WHERE device_id=$1 AND category=$2", [device_id, category])
        await tx.execute("UPDATE prompt_templates SET is_default=true WHERE id=$1", [template_id])

    await ds.transaction(_set)
    return {"success": True, "message": "Default template set"}
