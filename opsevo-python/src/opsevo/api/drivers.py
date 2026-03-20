"""Drivers & Profiles API routes.

GET  /api/drivers                — list available drivers
GET  /api/drivers/{type}/manifest — driver capability manifest
GET  /api/profiles               — list API profiles
POST /api/profiles               — create profile
GET  /api/profiles/{id}          — get profile
PUT  /api/profiles/{id}          — update profile
DELETE /api/profiles/{id}        — delete profile
POST /api/profiles/import        — import profile
GET  /api/profiles/{id}/export   — export profile

Frontend: driverApi + profileApi in frontend/src/api/device.ts
"""

from __future__ import annotations

import json
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile, File

from opsevo.api.deps import get_current_user, get_datastore

router = APIRouter(prefix="/api", tags=["drivers"])


def _get_driver_manager(request: Request):
    return request.app.state.container.driver_manager()


def _profile_to_camel(row: dict | None) -> dict | None:
    """Convert DB snake_case keys to frontend camelCase for profile rows."""
    if row is None:
        return None
    out = {}
    for k, v in row.items():
        if k == "target_system":
            out["targetSystem"] = v
        elif k == "created_at":
            out["created_at"] = str(v) if v else None
        elif k == "updated_at":
            out["updated_at"] = str(v) if v else None
        else:
            out[k] = v
    return out


# ==================== Drivers ====================

@router.get("/drivers")
async def list_drivers(
    request: Request,
    user: dict = Depends(get_current_user),
):
    dm = _get_driver_manager(request)
    profiles = dm.profiles
    drivers = []
    seen_types: set[str] = set()
    for name, profile in profiles.items():
        dt = profile.driver_type
        if dt not in seen_types:
            seen_types.add(dt)
            drivers.append({
                "type": dt,
                "name": f"{dt.upper()} Driver",
                "version": "1.0.0",
                "status": "active",
                "capabilities": profile.data_capabilities or [],
            })
    # Always include the three built-in driver types
    for dt in ("api", "ssh", "snmp"):
        if dt not in seen_types:
            drivers.append({
                "type": dt,
                "name": f"{dt.upper()} Driver",
                "version": "1.0.0",
                "status": "active",
                "capabilities": [],
            })
    return {"success": True, "data": drivers}


@router.get("/drivers/profiles")
async def list_driver_profiles(
    request: Request,
    user: dict = Depends(get_current_user),
):
    """Return per-profile records keyed by YAML filename stem.

    This is what the frontend needs for the Profile ID dropdown:
    create_driver(profile_name) looks up by YAML stem, so the dropdown
    value must be the stem (e.g. 'mikrotik-routeros'), not the driver_type.
    """
    dm = _get_driver_manager(request)
    profiles = dm.profiles
    result = []
    for name, profile in profiles.items():
        result.append({
            "name": name,
            "driver_type": profile.driver_type,
            "vendor": profile.vendor,
            "model": profile.model,
            "label": f"{profile.vendor} {profile.model}",
        })
    return {"success": True, "data": result}


@router.get("/drivers/{driver_type}/manifest")
async def get_driver_manifest(
    driver_type: str,
    request: Request,
    user: dict = Depends(get_current_user),
):
    dm = _get_driver_manager(request)
    # Find a profile that uses this driver type to extract capabilities
    target_profile = None
    for name, profile in dm.profiles.items():
        if profile.driver_type == driver_type:
            target_profile = profile
            break

    operations = []
    supported_metrics = []
    command_patterns = []

    if target_profile:
        operations = [ep.action_type for ep in target_profile.endpoints]
        supported_metrics = list(target_profile.metrics_endpoints.keys())
        command_patterns = [
            {"name": ep.action_type, "description": f"{ep.method} {ep.path}"}
            for ep in target_profile.endpoints
        ]
    else:
        # Default capabilities per driver type
        if driver_type == "api":
            operations = ["get_system_resources", "get_interfaces", "export_config", "import_config"]
            supported_metrics = ["cpu", "memory", "disk", "interfaces"]
        elif driver_type == "ssh":
            operations = ["run_script", "get_system_resources"]
            supported_metrics = ["cpu", "memory"]
        elif driver_type == "snmp":
            operations = ["snmp_get", "snmp_walk"]
            supported_metrics = ["interfaces", "system"]

    return {
        "success": True,
        "data": {
            "operations": operations,
            "supportedMetrics": supported_metrics,
            "commandPatterns": command_patterns,
        },
    }


# ==================== Profiles ====================

@router.get("/profiles")
async def list_profiles(
    request: Request,
    ds=Depends(get_datastore),
    user: dict = Depends(get_current_user),
):
    rows = await ds.query(
        "SELECT * FROM api_profiles ORDER BY created_at DESC"
    )
    return {"success": True, "data": [_profile_to_camel(r) for r in (rows or [])]}


@router.post("/profiles")
async def create_profile(
    request: Request,
    ds=Depends(get_datastore),
    user: dict = Depends(get_current_user),
):
    body = await request.json()
    pid = str(uuid.uuid4())
    name = body.get("name", "")
    target_system = body.get("targetSystem", "")
    version = body.get("version", "1.0")
    endpoints = json.dumps(body.get("endpoints", {}), ensure_ascii=False)
    auth = json.dumps(body.get("auth", {}), ensure_ascii=False)
    await ds.execute(
        "INSERT INTO api_profiles (id, name, target_system, version, endpoints, auth, created_at, updated_at) "
        "VALUES ($1,$2,$3,$4,$5,$6,NOW(),NOW())",
        [pid, name, target_system, version, endpoints, auth],
    )
    row = await ds.query_one("SELECT * FROM api_profiles WHERE id=$1", [pid])
    return {"success": True, "data": _profile_to_camel(row)}


@router.get("/profiles/{profile_id}")
async def get_profile(
    profile_id: str,
    ds=Depends(get_datastore),
    user: dict = Depends(get_current_user),
):
    row = await ds.query_one("SELECT * FROM api_profiles WHERE id=$1", [profile_id])
    if not row:
        raise HTTPException(404, "Profile not found")
    return {"success": True, "data": _profile_to_camel(row)}


@router.put("/profiles/{profile_id}")
async def update_profile(
    profile_id: str,
    request: Request,
    ds=Depends(get_datastore),
    user: dict = Depends(get_current_user),
):
    body = await request.json()
    existing = await ds.query_one("SELECT * FROM api_profiles WHERE id=$1", [profile_id])
    if not existing:
        raise HTTPException(404, "Profile not found")
    sets, params, idx = [], [], 1
    allowed = {"name", "target_system", "targetSystem", "version", "endpoints", "auth"}
    col_map = {"targetSystem": "target_system"}
    for k, v in body.items():
        col = col_map.get(k, k)
        if col not in allowed and k not in allowed:
            continue
        if col in ("endpoints", "auth") and isinstance(v, dict):
            v = json.dumps(v, ensure_ascii=False)
        sets.append(f"{col} = ${idx}")
        params.append(v)
        idx += 1
    if sets:
        sets.append(f"updated_at = NOW()")
        params.append(profile_id)
        await ds.execute(
            f"UPDATE api_profiles SET {', '.join(sets)} WHERE id = ${idx}",
            tuple(params),
        )
    row = await ds.query_one("SELECT * FROM api_profiles WHERE id=$1", [profile_id])
    return {"success": True, "data": _profile_to_camel(row)}


@router.delete("/profiles/{profile_id}")
async def delete_profile(
    profile_id: str,
    ds=Depends(get_datastore),
    user: dict = Depends(get_current_user),
):
    existing = await ds.query_one("SELECT * FROM api_profiles WHERE id=$1", [profile_id])
    if not existing:
        raise HTTPException(404, "Profile not found")
    await ds.execute("DELETE FROM api_profiles WHERE id=$1", [profile_id])
    return {"success": True, "message": "Profile deleted"}


@router.post("/profiles/import")
async def import_profile(
    request: Request,
    ds=Depends(get_datastore),
    user: dict = Depends(get_current_user),
):
    """Import a profile from JSON body or form data."""
    content_type = request.headers.get("content-type", "")
    if "multipart/form-data" in content_type:
        form = await request.form()
        file = form.get("file")
        if file is None:
            raise HTTPException(400, "No file provided")
        raw = await file.read()
        body = json.loads(raw)
    else:
        body = await request.json()

    pid = str(uuid.uuid4())
    name = body.get("name", "Imported Profile")
    target_system = body.get("targetSystem", body.get("target_system", ""))
    version = body.get("version", "1.0")
    endpoints = json.dumps(body.get("endpoints", {}), ensure_ascii=False)
    auth = json.dumps(body.get("auth", {}), ensure_ascii=False)
    await ds.execute(
        "INSERT INTO api_profiles (id, name, target_system, version, endpoints, auth, created_at, updated_at) "
        "VALUES ($1,$2,$3,$4,$5,$6,NOW(),NOW())",
        [pid, name, target_system, version, endpoints, auth],
    )
    row = await ds.query_one("SELECT * FROM api_profiles WHERE id=$1", [pid])
    return {"success": True, "data": _profile_to_camel(row)}


@router.get("/profiles/{profile_id}/export")
async def export_profile(
    profile_id: str,
    ds=Depends(get_datastore),
    user: dict = Depends(get_current_user),
):
    row = await ds.query_one("SELECT * FROM api_profiles WHERE id=$1", [profile_id])
    if not row:
        raise HTTPException(404, "Profile not found")
    from fastapi.responses import Response
    export_data = json.dumps(_profile_to_camel(row), default=str, ensure_ascii=False)
    return Response(
        content=export_data,
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="profile-{profile_id}.json"'},
    )
