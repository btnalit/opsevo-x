"""
Skill API 路由

端点:
- GET    /api/skills                          列出所有 Skill
- GET    /api/skills/metrics/all              获取所有 Skill 指标
- GET    /api/skills/templates/list           获取模板列表
- POST   /api/skills/from-template            从模板创建
- POST   /api/skills/import                   导入 Skill
- GET    /api/skills/tools/health             工具健康状态
- GET    /api/skills/tools/health/{tool}      单个工具健康
- GET    /api/skills/tools/metrics            工具指标
- POST   /api/skills/tools/circuit-breaker/{tool}/reset  重置熔断器
- GET    /api/skills/{name}                   获取 Skill 详情
- POST   /api/skills                          创建 Skill
- PUT    /api/skills/{name}                   更新 Skill
- DELETE /api/skills/{name}                   删除 Skill
- PUT    /api/skills/{name}/toggle            启用/禁用
- GET    /api/skills/{name}/metrics           获取 Skill 指标
- POST   /api/skills/{name}/test              测试 Skill
- POST   /api/skills/{name}/clone             克隆 Skill
- GET    /api/skills/{name}/files             列出文件
- GET    /api/skills/{name}/files/{filename}  读取文件
- PUT    /api/skills/{name}/files/{filename}  更新文件
- GET    /api/skills/{name}/export            导出 Skill
"""

from __future__ import annotations

import math
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel

from opsevo.api.deps import get_current_user

router = APIRouter(prefix="/api/ai-ops/skills", tags=["skills"])


# ------------------------------------------------------------------
# Request / Response models
# ------------------------------------------------------------------

class CreateSkillRequest(BaseModel):
    name: str
    description: str
    content: str | None = None
    config: dict[str, Any] | None = None


class UpdateSkillRequest(BaseModel):
    description: str | None = None
    content: str | None = None
    config: dict[str, Any] | None = None


class ToggleRequest(BaseModel):
    enabled: bool


class FromTemplateRequest(BaseModel):
    template_id: str
    name: str
    description: str


class TestSkillRequest(BaseModel):
    message: str


class CloneRequest(BaseModel):
    new_name: str


class UpdateFileRequest(BaseModel):
    content: str


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------

def _get_skill_manager(request: Request):
    provider = getattr(request.app.state.container, "skill_manager", None)
    if provider is None:
        raise HTTPException(503, "Skill manager service not available")
    return provider()


def _get_skill_loader(request: Request):
    provider = getattr(request.app.state.container, "skill_loader", None)
    if provider is None:
        raise HTTPException(503, "Skill loader service not available")
    return provider()


# ------------------------------------------------------------------
# 静态路由（必须在动态 /{name} 之前）
# ------------------------------------------------------------------

@router.get("/metrics/all")
async def get_all_metrics(
    request: Request,
    _user: dict = Depends(get_current_user),
):
    mgr = _get_skill_manager(request)
    metrics_svc = getattr(mgr, "_metrics_service", None)
    if metrics_svc:
        return {"success": True, "data": [vars(m) for m in metrics_svc.get_all_metrics()]}
    return {"success": True, "data": []}


@router.get("/tools/health")
async def get_all_tool_health(
    request: Request,
    _user: dict = Depends(get_current_user),
):
    mgr = _get_skill_manager(request)
    metrics_svc = getattr(mgr, "_metrics_service", None)
    if not metrics_svc:
        return {"success": True, "data": {"tools": [], "unhealthyCount": 0}}
    health = metrics_svc.get_all_tool_health_status()
    unhealthy = metrics_svc.get_unhealthy_tools()
    global_stats = metrics_svc.get_global_failure_stats()
    return {
        "success": True,
        "data": {
            "tools": [vars(h) for h in health],
            "unhealthyCount": len(unhealthy),
            "unhealthyTools": [h.tool_name for h in unhealthy],
            "globalStats": global_stats,
        },
    }


@router.get("/tools/health/{tool_name}")
async def get_tool_health(
    tool_name: str,
    request: Request,
    _user: dict = Depends(get_current_user),
):
    mgr = _get_skill_manager(request)
    metrics_svc = getattr(mgr, "_metrics_service", None)
    if not metrics_svc:
        raise HTTPException(404, f"No metrics found for tool: {tool_name}")
    hs = metrics_svc.get_tool_health_status(tool_name)
    if not hs:
        raise HTTPException(404, f"No metrics found for tool: {tool_name}")
    analysis = metrics_svc.analyze_failure_patterns(tool_name)
    return {"success": True, "data": {"health": vars(hs), "failureAnalysis": analysis}}


@router.get("/tools/metrics")
async def get_tool_metrics(
    request: Request,
    _user: dict = Depends(get_current_user),
):
    mgr = _get_skill_manager(request)
    metrics_svc = getattr(mgr, "_metrics_service", None)
    if not metrics_svc:
        return {"success": True, "data": {"metrics": [], "priorityRanking": []}}
    tools = metrics_svc.get_all_tool_metrics()
    ranking = metrics_svc.get_tool_priority_ranking()
    return {
        "success": True,
        "data": {
            "metrics": [
                {
                    "tool_name": t.tool_name,
                    "total_calls": t.total_calls,
                    "success_count": t.success_count,
                    "failure_count": t.failure_count,
                    "health_score": t.health_score,
                    "circuit_breaker_open": t.circuit_breaker_open,
                }
                for t in tools
            ],
            "priorityRanking": ranking,
        },
    }


@router.post("/tools/circuit-breaker/{tool_name}/reset")
async def reset_circuit_breaker(
    tool_name: str,
    request: Request,
    _user: dict = Depends(get_current_user),
):
    mgr = _get_skill_manager(request)
    metrics_svc = getattr(mgr, "_metrics_service", None)
    if not metrics_svc or not metrics_svc.get_tool_metrics(tool_name):
        raise HTTPException(404, f"No metrics found for tool: {tool_name}")
    metrics_svc.close_circuit_breaker(tool_name)
    return {
        "success": True,
        "data": {"toolName": tool_name, "circuitBreakerOpen": False},
    }


@router.post("/tools/{tool_name}/reset-metrics")
async def reset_tool_metrics(
    tool_name: str,
    request: Request,
    _user: dict = Depends(get_current_user),
):
    mgr = _get_skill_manager(request)
    metrics_svc = getattr(mgr, "_metrics_service", None)
    if not metrics_svc or not metrics_svc.reset_tool_metrics(tool_name):
        raise HTTPException(404, f"No metrics found for tool: {tool_name}")
    return {"success": True, "data": {"toolName": tool_name, "message": "Tool metrics reset"}}


@router.get("/templates/list")
async def list_templates(_user: dict = Depends(get_current_user)):
    templates = [
        {
            "id": "basic",
            "name": "基础 Skill",
            "description": "最简单的 Skill 模板",
            "config": {"allowedTools": ["*"], "caps": {"temperature": 0.7, "maxIterations": 5}},
        },
        {
            "id": "diagnostic",
            "name": "诊断型 Skill",
            "description": "用于故障诊断的 Skill 模板",
            "config": {
                "allowedTools": ["get_system_info", "get_interface_status", "get_logs", "analyze_metrics"],
                "caps": {"temperature": 0.3, "maxIterations": 10},
            },
        },
        {
            "id": "configurator",
            "name": "配置型 Skill",
            "description": "用于生成配置的 Skill 模板",
            "config": {
                "allowedTools": ["generate_config", "validate_config", "apply_config"],
                "caps": {"temperature": 0.5, "maxIterations": 5},
            },
        },
        {
            "id": "auditor",
            "name": "审计型 Skill",
            "description": "用于安全审计的 Skill 模板",
            "config": {
                "allowedTools": ["get_firewall_rules", "get_users", "get_services", "check_security"],
                "caps": {"temperature": 0.2, "maxIterations": 8},
            },
        },
    ]
    return {"success": True, "data": templates}


@router.post("/from-template", status_code=201)
async def create_from_template(
    body: FromTemplateRequest,
    request: Request,
    _user: dict = Depends(get_current_user),
):
    mgr = _get_skill_manager(request)
    loader = _get_skill_loader(request)
    existing = mgr.get(body.name)
    if existing:
        raise HTTPException(409, f"Skill already exists: {body.name}")

    template_configs: dict[str, dict] = {
        "basic": {"allowedTools": ["*"], "caps": {"temperature": 0.7, "maxIterations": 5}},
        "diagnostic": {
            "allowedTools": ["get_system_info", "get_interface_status", "get_logs"],
            "caps": {"temperature": 0.3, "maxIterations": 10},
        },
        "configurator": {
            "allowedTools": ["generate_config", "validate_config", "apply_config"],
            "caps": {"temperature": 0.5, "maxIterations": 5},
        },
        "auditor": {
            "allowedTools": ["get_firewall_rules", "get_users", "get_services"],
            "caps": {"temperature": 0.2, "maxIterations": 8},
        },
    }
    tpl = template_configs.get(body.template_id)
    if not tpl:
        raise HTTPException(400, f"Unknown template: {body.template_id}")

    skill = await loader.create_skill(body.name, description=body.description, config=tpl)
    mgr.register(body.name, skill)
    return {
        "success": True,
        "data": {"name": body.name, "description": body.description, "templateId": body.template_id},
    }


@router.post("/import", status_code=201)
async def import_skill(
    request: Request,
    _user: dict = Depends(get_current_user),
):
    body = await request.json()
    data = body.get("data", {})
    skill_data = data.get("skill", {})
    metadata = skill_data.get("metadata", {})
    name = metadata.get("name")
    if not name:
        raise HTTPException(400, "Invalid import data: missing name")
    mgr = _get_skill_manager(request)
    loader = _get_skill_loader(request)
    overwrite = body.get("overwrite", False)
    existing = mgr.get(name)
    if existing and not overwrite:
        raise HTTPException(409, f"Skill already exists: {name}. Set overwrite=true to replace.")
    skill = await loader.create_skill(
        name,
        description=metadata.get("description", ""),
        config=skill_data.get("config", {}),
    )
    mgr.register(name, skill)
    return {"success": True, "data": {"name": name, "imported": True, "source": "json"}}


# ------------------------------------------------------------------
# 基础 CRUD
# ------------------------------------------------------------------

@router.get("")
async def list_skills(
    request: Request,
    builtin: str | None = Query(None),
    enabled: str | None = Query(None),
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    _user: dict = Depends(get_current_user),
):
    mgr = _get_skill_manager(request)
    skills = mgr.list_all()
    if builtin is not None:
        is_builtin = builtin.lower() == "true"
        skills = [s for s in skills if s.get("isBuiltin") == is_builtin]
    if enabled is not None:
        is_enabled = enabled.lower() == "true"
        skills = [s for s in skills if s.get("enabled") == is_enabled]
    total = len(skills)
    start = (page - 1) * limit
    paginated = skills[start : start + limit]
    return {
        "success": True,
        "data": paginated,
        "pagination": {
            "page": page,
            "limit": limit,
            "total": total,
            "totalPages": math.ceil(total / limit) if limit else 0,
        },
    }


@router.post("", status_code=201)
async def create_skill(
    body: CreateSkillRequest,
    request: Request,
    _user: dict = Depends(get_current_user),
):
    mgr = _get_skill_manager(request)
    loader = _get_skill_loader(request)
    if mgr.get(body.name):
        raise HTTPException(409, f"Skill already exists: {body.name}")
    skill = await loader.create_skill(
        body.name,
        description=body.description,
        content=body.content,
        config=body.config or {},
    )
    mgr.register(body.name, skill)
    return {"success": True, "data": {"name": body.name, "description": body.description}}


# ------------------------------------------------------------------
# 动态路由 /{name}
# ------------------------------------------------------------------

@router.get("/{name}")
async def get_skill(
    name: str,
    request: Request,
    _user: dict = Depends(get_current_user),
):
    mgr = _get_skill_manager(request)
    skill = mgr.get(name)
    if not skill:
        raise HTTPException(404, f"Skill not found: {name}")
    return {"success": True, "data": skill}


@router.put("/{name}")
async def update_skill(
    name: str,
    body: UpdateSkillRequest,
    request: Request,
    _user: dict = Depends(get_current_user),
):
    mgr = _get_skill_manager(request)
    loader = _get_skill_loader(request)
    skill = mgr.get(name)
    if not skill:
        raise HTTPException(404, f"Skill not found: {name}")
    if skill.get("isBuiltin"):
        raise HTTPException(403, "Cannot modify builtin skill")
    updated = await loader.update_skill(name, description=body.description, content=body.content, config=body.config)
    mgr.register(name, updated)
    return {"success": True, "data": {"name": name}}


@router.delete("/{name}")
async def delete_skill(
    name: str,
    request: Request,
    _user: dict = Depends(get_current_user),
):
    mgr = _get_skill_manager(request)
    loader = _get_skill_loader(request)
    skill = mgr.get(name)
    if not skill:
        raise HTTPException(404, f"Skill not found: {name}")
    if skill.get("isBuiltin"):
        raise HTTPException(403, "Cannot delete builtin skill")
    mgr.unregister(name)
    await loader.delete_skill(name)
    return {"success": True, "message": f"Skill deleted: {name}"}


@router.put("/{name}/toggle")
async def toggle_skill(
    name: str,
    body: ToggleRequest,
    request: Request,
    _user: dict = Depends(get_current_user),
):
    mgr = _get_skill_manager(request)
    if body.enabled:
        ok = mgr.enable(name)
    else:
        ok = mgr.disable(name)
    if not ok:
        raise HTTPException(404, f"Skill not found: {name}")
    return {"success": True, "data": {"name": name, "enabled": body.enabled}}


@router.get("/{name}/metrics")
async def get_skill_metrics(
    name: str,
    request: Request,
    _user: dict = Depends(get_current_user),
):
    mgr = _get_skill_manager(request)
    metrics_svc = getattr(mgr, "_metrics_service", None)
    if not metrics_svc:
        raise HTTPException(404, f"No metrics found for skill: {name}")
    m = metrics_svc.get_metrics(name)
    if not m:
        raise HTTPException(404, f"No metrics found for skill: {name}")
    return {"success": True, "data": vars(m)}


@router.post("/{name}/test")
async def test_skill(
    name: str,
    body: TestSkillRequest,
    request: Request,
    _user: dict = Depends(get_current_user),
):
    mgr = _get_skill_manager(request)
    skill = mgr.get(name)
    if not skill:
        raise HTTPException(404, f"Skill not found: {name}")
    return {
        "success": True,
        "data": {
            "skill": name,
            "matchType": "override",
            "confidence": 1.0,
            "matchReason": "direct test",
        },
    }


@router.post("/{name}/clone", status_code=201)
async def clone_skill(
    name: str,
    body: CloneRequest,
    request: Request,
    _user: dict = Depends(get_current_user),
):
    mgr = _get_skill_manager(request)
    loader = _get_skill_loader(request)
    source = mgr.get(name)
    if not source:
        raise HTTPException(404, f"Skill not found: {name}")
    if mgr.get(body.new_name):
        raise HTTPException(409, f"Skill already exists: {body.new_name}")
    cloned = await loader.clone_skill(name, body.new_name)
    mgr.register(body.new_name, cloned)
    return {
        "success": True,
        "data": {"name": body.new_name, "clonedFrom": name},
    }


@router.get("/{name}/files")
async def list_skill_files(
    name: str,
    request: Request,
    _user: dict = Depends(get_current_user),
):
    mgr = _get_skill_manager(request)
    skill = mgr.get(name)
    if not skill:
        raise HTTPException(404, f"Skill not found: {name}")
    return {"success": True, "data": {"path": skill.get("path"), "files": skill.get("files", [])}}


@router.get("/{name}/files/{filename}")
async def read_skill_file(
    name: str,
    filename: str,
    request: Request,
    _user: dict = Depends(get_current_user),
):
    mgr = _get_skill_manager(request)
    loader = _get_skill_loader(request)
    skill = mgr.get(name)
    if not skill:
        raise HTTPException(404, f"Skill not found: {name}")
    content = await loader.read_skill_file(name, filename)
    return {"success": True, "data": {"filename": filename, "content": content}}


@router.put("/{name}/files/{filename}")
async def update_skill_file(
    name: str,
    filename: str,
    body: UpdateFileRequest,
    request: Request,
    _user: dict = Depends(get_current_user),
):
    mgr = _get_skill_manager(request)
    loader = _get_skill_loader(request)
    skill = mgr.get(name)
    if not skill:
        raise HTTPException(404, f"Skill not found: {name}")
    if skill.get("isBuiltin"):
        raise HTTPException(403, "Cannot modify builtin skill files")
    await loader.write_skill_file(name, filename, body.content)
    if filename in ("SKILL.md", "config.json"):
        updated = await loader.reload_skill(name)
        if updated:
            mgr.register(name, updated)
    return {"success": True, "data": {"filename": filename, "updated": True}}


@router.get("/{name}/export")
async def export_skill(
    name: str,
    request: Request,
    format: str = Query("json"),
    _user: dict = Depends(get_current_user),
):
    mgr = _get_skill_manager(request)
    skill = mgr.get(name)
    if not skill:
        raise HTTPException(404, f"Skill not found: {name}")
    return {"success": True, "data": {"skill": skill, "format": format}}
