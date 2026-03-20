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

from .deps import get_current_user, get_datastore, get_device_id

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
async def get_placeholders(device_id: str | None = Depends(get_device_id), user=Depends(get_current_user)) -> dict:
    return {"success": True, "data": _SYSTEM_PLACEHOLDERS}


@router.get("/default")
async def get_default_template(
    device_id: str | None = Depends(get_device_id), category: str = Query(None),
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
async def get_overrides(device_id: str | None = Depends(get_device_id), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    rows = await ds.query(
        "SELECT * FROM template_overrides WHERE device_id=$1", [device_id]
    )
    return {"success": True, "data": rows}


@router.post("/overrides")
async def set_override(device_id: str | None = Depends(get_device_id), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
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
async def clear_override(device_id: str | None = Depends(get_device_id), system_template_name: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    await ds.execute(
        "DELETE FROM template_overrides WHERE device_id=$1 AND system_template_name=$2",
        [device_id, system_template_name],
    )
    rows = await ds.query("SELECT * FROM template_overrides WHERE device_id=$1", [device_id])
    return {"success": True, "data": rows}


# ==================== CRUD 路由 ====================
@router.get("")
async def get_templates(
    device_id: str | None = Depends(get_device_id),
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
async def create_template(device_id: str | None = Depends(get_device_id), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
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


# ==================== 版本历史 & 回滚 (Bug 1.5, 1.6) ====================

@router.get("/{template_id}/versions")
async def get_template_versions(
    template_id: str = Path(...),
    limit: int = Query(50, le=500, ge=1),
    ds=Depends(get_datastore),
    user=Depends(get_current_user),
) -> dict:
    rows = await ds.query(
        "SELECT * FROM prompt_template_versions WHERE template_id=$1 ORDER BY version DESC LIMIT $2",
        [template_id, limit],
    )
    return {"success": True, "data": rows}


@router.post("/{template_id}/rollback")
async def rollback_template(
    template_id: str = Path(...),
    request: Request = None,
    ds=Depends(get_datastore),
    user=Depends(get_current_user),
) -> dict:
    body = await request.json()
    target_version = body.get("version")
    if target_version is None:
        raise HTTPException(400, "version is required")

    async def _tx(tx):
        # 锁定当前模板
        current = await tx.query_one(
            "SELECT * FROM prompt_templates WHERE id=$1 FOR UPDATE", [template_id]
        )
        if not current:
            raise HTTPException(404, "模板不存在")
        # 读取目标版本
        ver_row = await tx.query_one(
            "SELECT * FROM prompt_template_versions WHERE template_id=$1 AND version=$2",
            [template_id, target_version],
        )
        if not ver_row:
            raise HTTPException(404, f"Version {target_version} not found")
        # 保存当前版本到历史
        cur_version = current.get("version", 1)
        await tx.execute(
            "INSERT INTO prompt_template_versions (template_id, version, name, content, description, category) "
            "VALUES ($1,$2,$3,$4,$5,$6)",
            [template_id, cur_version, current.get("name"), current.get("content"),
             current.get("description"), current.get("category")],
        )
        # 用目标版本内容更新模板
        restored_placeholders = json.dumps(_extract_placeholders(ver_row["content"]))
        await tx.execute(
            "UPDATE prompt_templates SET name=COALESCE($2,name), content=$3, description=COALESCE($4,description), "
            "category=COALESCE($5,category), placeholders=$6, version=$7, updated_at=NOW() WHERE id=$1",
            [template_id, ver_row.get("name"), ver_row["content"],
             ver_row.get("description"), ver_row.get("category"), restored_placeholders, cur_version + 1],
        )

    await ds.transaction(_tx)
    row = await ds.query_one("SELECT * FROM prompt_templates WHERE id=$1", [template_id])
    return {"success": True, "data": row}


@router.get("/{template_id}")
async def get_template_by_id(device_id: str | None = Depends(get_device_id), template_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one(
        "SELECT * FROM prompt_templates WHERE id=$1 AND device_id=$2", [template_id, device_id]
    )
    if not row:
        raise HTTPException(404, "模板不存在")
    return {"success": True, "data": row}


@router.put("/{template_id}")
async def update_template(device_id: str | None = Depends(get_device_id), template_id: str = Path(...), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()

    async def _tx(tx):
        # SELECT FOR UPDATE 锁定当前模板行
        existing = await tx.query_one("SELECT * FROM prompt_templates WHERE id=$1 FOR UPDATE", [template_id])
        if not existing:
            raise HTTPException(404, "模板不存在")
        # 构建 UPDATE
        sets, params, idx = [], [], 1
        for k in ("name", "content", "description", "category", "is_default"):
            camel = k.replace("_d", "D").replace("_n", "N").replace("_c", "C")
            val = body.get(k)
            if val is None:
                val = body.get(camel)
            if val is not None:
                sets.append(f"{k} = ${idx}")
                params.append(val)
                idx += 1
        new_content = body.get("content")
        if new_content:
            sets.append(f"placeholders = ${idx}")
            params.append(json.dumps(_extract_placeholders(new_content)))
            idx += 1
        # 检查是否有实质性变更（内容相同则跳过版本递增）
        has_content_change = False
        for k in ("name", "content", "description", "category"):
            camel = k.replace("_d", "D").replace("_n", "N").replace("_c", "C")
            val = body.get(k)
            if val is None:
                val = body.get(camel)
            if val is not None and val != existing.get(k):
                has_content_change = True
                break
        if has_content_change:
            # 快照当前版本到历史表
            cur_version = existing.get("version", 1)
            await tx.execute(
                "INSERT INTO prompt_template_versions (template_id, version, name, content, description, category) "
                "VALUES ($1,$2,$3,$4,$5,$6)",
                [template_id, cur_version, existing.get("name"), existing.get("content"),
                 existing.get("description"), existing.get("category")],
            )
            # 递增版本号
            sets.append(f"version = ${idx}")
            params.append(cur_version + 1)
            idx += 1
        if sets:
            params.append(template_id)
            await tx.execute(f"UPDATE prompt_templates SET {', '.join(sets)}, updated_at=NOW() WHERE id = ${idx}", tuple(params))

    await ds.transaction(_tx)
    row = await ds.query_one("SELECT * FROM prompt_templates WHERE id=$1", [template_id])
    return {"success": True, "data": row}


@router.delete("/{template_id}")
async def delete_template(device_id: str | None = Depends(get_device_id), template_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    existing = await ds.query_one("SELECT * FROM prompt_templates WHERE id=$1 AND device_id=$2", [template_id, device_id])
    if not existing:
        raise HTTPException(404, "模板不存在")
    await ds.execute("DELETE FROM prompt_templates WHERE id=$1 AND device_id=$2", [template_id, device_id])
    return {"success": True, "message": "Template deleted"}


@router.post("/{template_id}/render")
async def render_template(device_id: str | None = Depends(get_device_id), template_id: str = Path(...), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one("SELECT * FROM prompt_templates WHERE id=$1 AND device_id=$2", [template_id, device_id])
    if not row:
        raise HTTPException(404, "模板不存在")
    body = await request.json()
    content = row.get("content", "")
    # Replace {{placeholder}} with provided values
    for key, value in body.items():
        content = content.replace(f"{{{{{key}}}}}", str(value))
    return {"success": True, "data": {"content": content, "rendered": content}}


@router.post("/{template_id}/default")
async def set_default_template(device_id: str | None = Depends(get_device_id), template_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    existing = await ds.query_one("SELECT * FROM prompt_templates WHERE id=$1 AND device_id=$2", [template_id, device_id])
    if not existing:
        raise HTTPException(404, "模板不存在")
    category = existing.get("category", "general")

    async def _set(tx):
        await tx.execute("UPDATE prompt_templates SET is_default=false WHERE device_id=$1 AND category=$2", [device_id, category])
        await tx.execute("UPDATE prompt_templates SET is_default=true WHERE id=$1", [template_id])

    await ds.transaction(_set)
    return {"success": True, "message": "Default template set"}
