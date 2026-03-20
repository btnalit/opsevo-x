"""
API 响应格式化工具

提供 snake_case → camelCase 的通用转换，以及各实体类型的专用格式化函数。
DB 列名使用 snake_case，前端 TypeScript 接口使用 camelCase。
"""

from __future__ import annotations

import re
from typing import Any


def _snake_to_camel(name: str) -> str:
    """Convert a single snake_case key to camelCase.

    Examples:
        device_id   -> deviceId
        created_at  -> createdAt
        auto_heal   -> autoHeal
        id          -> id  (unchanged)
    """
    parts = name.split("_")
    return parts[0] + "".join(p.capitalize() for p in parts[1:])


def _camel_to_snake(name: str) -> str:
    """Convert a single camelCase key to snake_case.

    Examples:
        deviceId    -> device_id
        createdAt   -> created_at
        autoHeal    -> auto_heal
    """
    return re.sub(r"(?<=[a-z0-9])([A-Z])", r"_\1", name).lower()


def snake_to_camel(row: dict[str, Any] | None) -> dict[str, Any] | None:
    """Convert all snake_case keys in a dict to camelCase.

    Returns None if input is None.
    Handles nested dicts but leaves list items untouched (they may be
    heterogeneous JSON blobs that shouldn't be renamed).
    """
    if row is None:
        return None
    return {_snake_to_camel(k): v for k, v in row.items()}


def snake_to_camel_list(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Convert a list of dicts from snake_case to camelCase."""
    return [snake_to_camel(r) for r in rows]


def camel_to_snake_keys(body: dict[str, Any]) -> dict[str, Any]:
    """Convert all camelCase keys in a request body to snake_case.

    Useful for mapping frontend PUT/POST bodies to DB column names.
    """
    return {_camel_to_snake(k): v for k, v in body.items()}
